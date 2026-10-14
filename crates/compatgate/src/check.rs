use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::{NodeId, Semantic, SemanticBuilder};
use oxc_span::SourceType;

use crate::allow::{AllowList, Matcher};
use crate::data::FeatureId;
use crate::detect::guards::Guards;
use crate::detect::{Use, globals, methods, regex, syntax};
use crate::position::{LineIndex, Position};
use crate::support::{Gap, Verdict, evaluate};
use crate::targets::Targets;
use crate::{Error, ParseError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Syntax,
    Builtin,
    Api,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    /// The detector knows the feature is used.
    Exact,
    /// The detector guesses from a name: a method call on an object of unknown type.
    Heuristic,
    /// Some targets support the feature only partially. A heuristic use stays `Heuristic` in this case.
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub feature: &'static str,
    pub kind: Kind,
    pub confidence: Confidence,
    /// Other features the same code may use, for a heuristic finding. An `allow` entry for any of them
    /// suppresses the finding. Empty for other findings.
    pub alternatives: &'static [FeatureId],
    pub start: Position,
    pub end: Position,
    pub gaps: Vec<Gap>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckOutput {
    pub findings: Vec<Finding>,
    /// For each `allow` entry that suppressed a finding, the kind of that finding: one pair per entry and
    /// kind, ordered by the index of the entry, then by the kind in the order of `Kind`. The unique indexes
    /// are the entries that the file uses. A bundler lowers syntax after the check, so an entry that
    /// suppressed syntax only may be needed by none of the code in the bundle.
    pub suppressed: Vec<(usize, Kind)>,
}

pub fn check(source: &str, filename: &str, targets: &Targets, allow: &AllowList) -> Result<CheckOutput, Error> {
    check_as(source, filename, filename, targets, allow)
}

/// Like `check`, but `parse_as` selects the parser by its extension, and `filename` only matches the
/// `allow` entries. A bundler checks the script of `/src/App.vue` as `/src/App.vue.ts`, while the
/// `files` of an entry name `/src/App.vue`.
pub fn check_as(
    source: &str,
    filename: &str,
    parse_as: &str,
    targets: &Targets,
    allow: &AllowList,
) -> Result<CheckOutput, Error> {
    let mut output = with_semantic(source, parse_as, |semantic, allocator| {
        let ambient = syntax::ambient_nodes(semantic.nodes());
        // Detectors skip the features that the targets support, so every use is a candidate for a finding.
        let mut uses = globals::detect(semantic, targets);
        uses.extend(syntax::detect(semantic, &ambient, targets));
        uses.extend(regex::detect(semantic, allocator, targets));
        uses.extend(methods::detect(semantic, targets));
        let mut guards = Guards::new(semantic, targets);
        let matcher = allow.matcher(filename);
        // Each use with the `allow` entry that suppresses its finding, if any.
        let uses: Vec<(Use<'_>, Option<usize>)> = uses
            .into_iter()
            // TypeScript declarations produce no JavaScript: `declare namespace N { const a = X; }` never runs.
            .filter(|usage| !ambient[usage.node.index()])
            .filter(|usage| !guards.is_guarded(usage))
            .map(|usage| {
                let entry = allowed(&usage, &matcher);
                (usage, entry)
            })
            .collect();
        // A root gives way to the member read at the same place when the member is reported.
        let reported: HashSet<NodeId> = uses
            .iter()
            .filter(|(_, entry)| entry.is_none())
            .map(|(usage, _)| usage.node)
            .collect();
        let mut output = CheckOutput::default();
        let mut marks = Marks::new(allow.len());
        let mut lines = None;
        for (usage, entry) in uses {
            if usage.member.is_some_and(|member| reported.contains(&member)) {
                continue;
            }
            let verdict = evaluate(usage.feature, targets);
            let lines = lines.get_or_insert_with(|| LineIndex::new(source));
            record(&mut output, &mut marks, usage, entry, verdict, lines);
        }
        marks.write(&mut output);
        output
    })?;
    // Detectors walk hash maps, so the order of their output is not stable. Several findings can start
    // at one position, such as a shorthand method and a method definition at the key `m`; the feature and the
    // end order them.
    output.findings.sort_by_key(|finding| {
        (
            finding.start.line,
            finding.start.column,
            finding.feature,
            finding.end.line,
            finding.end.column,
        )
    });
    Ok(output)
}

/// The kinds of the findings that each `allow` entry suppressed, a bit per kind. A file can suppress
/// many findings: a mark per entry keeps the check linear, where a list of pairs would need a sort.
struct Marks(Vec<u8>);

impl Marks {
    const KINDS: [Kind; 3] = [Kind::Syntax, Kind::Builtin, Kind::Api];

    fn new(entries: usize) -> Self {
        Self(vec![0; entries])
    }

    fn mark(&mut self, index: usize, kind: Kind) {
        self.0[index] |= 1 << kind as u8;
    }

    fn write(self, output: &mut CheckOutput) {
        for (index, bits) in self.0.into_iter().enumerate().filter(|(_, bits)| *bits != 0) {
            for kind in Self::KINDS {
                if bits & (1 << kind as u8) != 0 {
                    output.suppressed.push((index, kind));
                }
            }
        }
    }
}

/// Whether `check` can parse a file with this name: JavaScript or TypeScript by the extension.
/// A bundler id with a query (`a.ts?v=1`) is no file name: the caller strips the query first.
pub fn is_checkable(filename: &str) -> bool {
    source_type(filename).is_ok()
}

fn source_type(filename: &str) -> Result<SourceType, Error> {
    // oxc knows only lower-case extensions, but `A.JS` is a valid file on case-insensitive file systems.
    let name = Path::new(filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase());
    let name = name.as_deref().unwrap_or(filename);
    SourceType::from_path(name).map_err(|_| {
        let what = match Path::new(name).extension() {
            Some(extension) => format!("the file extension \".{}\"", extension.to_string_lossy()),
            None => "a file without an extension".to_string(),
        };
        Error::UnsupportedFile(format!(
            "no parser for {what}; compatgate checks .js, .mjs, .cjs, .jsx, .ts, .mts, .cts and .tsx"
        ))
    })
}

/// Parses the source and builds the scope data. Detector tests use it too, so they parse exactly
/// like `check` does.
pub(crate) fn with_semantic<R>(
    source: &str,
    filename: &str,
    run: impl for<'a> FnOnce(&Semantic<'a>, &'a Allocator) -> R,
) -> Result<R, Error> {
    let mut source_type = source_type(filename)?;
    // oxc parses `.js` without JSX, but React projects keep JSX in `.js` files, and linters accept it.
    if source_type.is_javascript() {
        source_type = source_type.with_jsx(true);
    }
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            parse_regular_expression: true,
            // CommonJS lets a module return at the top level, and packages in node_modules do it.
            allow_return_outside_function: true,
            ..ParseOptions::default()
        })
        .parse();
    if let Some(error) = parsed.diagnostics.errors().next() {
        let offset = error.labels.first().map_or(0, |label| label.offset());
        return Err(Error::Parse(ParseError {
            message: error.message.to_string(),
            position: LineIndex::new(source).position(offset),
        }));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    Ok(run(&semantic, &allocator))
}

/// `entry`: the `allow` entry that suppresses the finding of the use, if any.
fn record(
    output: &mut CheckOutput,
    marks: &mut Marks,
    usage: Use<'_>,
    entry: Option<usize>,
    verdict: Verdict,
    lines: &LineIndex<'_>,
) {
    let (confidence, gaps) = match verdict {
        Verdict::Supported => return,
        Verdict::Unsupported(gaps) => (usage.confidence, gaps),
        // A guessed use stays a guess: partial support of a feature that the code may not use is no fact.
        Verdict::Partial(gaps) if usage.confidence == Confidence::Heuristic => (Confidence::Heuristic, gaps),
        Verdict::Partial(gaps) => (Confidence::Partial, gaps),
    };
    if let Some(index) = entry {
        marks.mark(index, usage.kind);
        return;
    }
    output.findings.push(Finding {
        feature: usage.feature.as_str(),
        kind: usage.kind,
        confidence,
        alternatives: usage.alternatives,
        start: lines.position(usage.span.start),
        end: lines.position(usage.span.end),
        gaps,
    });
}

/// The `allow` entry that suppresses the finding of the use, if any.
fn allowed(usage: &Use<'_>, matcher: &Matcher<'_>) -> Option<usize> {
    std::iter::once(usage.feature)
        .chain(usage.alternatives.iter().copied())
        .find_map(|feature| matcher.find(feature.as_str()))
}

#[cfg(test)]
mod tests {
    use oxc_semantic::NodeId;
    use oxc_span::Span;

    use super::*;
    use crate::data::FeatureId;
    use crate::detect::Origin;

    #[test]
    fn a_heuristic_use_with_partial_support_stays_heuristic() {
        // In BCD 8.1.4 no method that the methods detector reports has partial support,
        // so the use is built by hand.
        let targets = Targets::resolve("Chrome >= 97").unwrap();
        let feature = FeatureId::find("api.BarcodeDetector").unwrap();
        let usage = Use {
            confidence: Confidence::Heuristic,
            ..Use::new(feature, Kind::Builtin, Origin::Member, Span::new(0, 1), NodeId::DUMMY)
        };
        let mut output = CheckOutput::default();
        let verdict = evaluate(feature, &targets);
        assert!(matches!(verdict, Verdict::Partial(_)), "{verdict:?}");
        record(
            &mut output,
            &mut Marks::new(0),
            usage,
            None,
            verdict,
            &LineIndex::new("x"),
        );
        let finding = &output.findings[0];
        assert_eq!(finding.confidence, Confidence::Heuristic);
        assert!(
            finding.gaps[0].note.is_some_and(|note| note.contains("ChromeOS")),
            "{finding:?}"
        );
    }
}
