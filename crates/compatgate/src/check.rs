use std::path::Path;

use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::{Semantic, SemanticBuilder};
use oxc_span::SourceType;

use crate::Error;
use crate::allow::AllowList;
use crate::detect::{Use, globals, guards, methods, regex, syntax};
use crate::position::{LineIndex, Position};
use crate::support::{Gap, Verdict, evaluate};
use crate::targets::Targets;

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
    /// Some targets support the feature only partially.
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub feature: &'static str,
    pub kind: Kind,
    pub confidence: Confidence,
    pub start: Position,
    pub end: Position,
    pub gaps: Vec<Gap>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckOutput {
    pub findings: Vec<Finding>,
    /// Indexes of `allow` entries that suppressed at least one finding.
    pub used_allow: Vec<usize>,
}

pub fn check(source: &str, filename: &str, targets: &Targets, allow: &AllowList) -> Result<CheckOutput, Error> {
    let uses = with_semantic(source, filename, |semantic, allocator| {
        let mut uses = globals::detect(semantic);
        uses.extend(syntax::detect(semantic));
        uses.extend(regex::detect(semantic, allocator));
        uses.extend(methods::detect(semantic, targets));
        uses.retain(|usage| !guards::is_guarded(semantic, usage));
        uses
    })?;
    let lines = LineIndex::new(source);
    let mut output = CheckOutput::default();
    for usage in uses {
        record(&mut output, usage, filename, targets, allow, &lines);
    }
    // Detectors walk hash maps, so the order of their output is not stable.
    output
        .findings
        .sort_by_key(|finding| (finding.start.line, finding.start.column));
    output.used_allow.sort_unstable();
    output.used_allow.dedup();
    Ok(output)
}

/// Parses the source and builds the scope data. Detector tests use it too, so they parse exactly
/// like `check` does.
pub(crate) fn with_semantic<R>(
    source: &str,
    filename: &str,
    run: impl for<'a> FnOnce(&Semantic<'a>, &'a Allocator) -> R,
) -> Result<R, Error> {
    // oxc knows only lower-case extensions, but `A.JS` is a valid file on case-insensitive file systems.
    let name = Path::new(filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase());
    let mut source_type = SourceType::from_path(name.as_deref().unwrap_or(filename))
        .map_err(|error| Error::Parse(format!("{filename}: {error}")))?;
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
        let location = error
            .labels
            .first()
            .map(|label| LineIndex::new(source).position(label.offset()))
            .map_or(String::new(), |position| {
                format!(":{}:{}", position.line, position.column + 1)
            });
        return Err(Error::Parse(format!("{filename}{location}: {}", error.message)));
    }
    let semantic = SemanticBuilder::new()
        .with_build_nodes(true)
        .build(&parsed.program)
        .semantic;
    Ok(run(&semantic, &allocator))
}

fn record(
    output: &mut CheckOutput,
    usage: Use,
    filename: &str,
    targets: &Targets,
    allow: &AllowList,
    lines: &LineIndex<'_>,
) {
    let (confidence, gaps) = match evaluate(usage.feature, targets) {
        Verdict::Supported => return,
        Verdict::Unsupported(gaps) => (usage.confidence, gaps),
        Verdict::Partial(gaps) => (Confidence::Partial, gaps),
    };
    let allowed = std::iter::once(usage.feature)
        .chain(usage.alternatives.iter().copied())
        .find_map(|feature| allow.find(feature.as_str(), filename));
    if let Some(index) = allowed {
        output.used_allow.push(index);
        return;
    }
    output.findings.push(Finding {
        feature: usage.feature.as_str(),
        kind: usage.kind,
        confidence,
        start: lines.position(usage.span.start),
        end: lines.position(usage.span.end),
        gaps,
    });
}
