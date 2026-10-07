use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

use crate::Error;
use crate::allow::AllowList;
use crate::detect::{Use, globals};
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
    /// The detector guesses from a name. Plan 2 adds the first such detector.
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
    let source_type = SourceType::from_path(filename).map_err(|error| Error::Parse(format!("{filename}: {error}")))?;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions { parse_regular_expression: true, ..ParseOptions::default() })
        .parse();
    if let Some(error) = parsed.diagnostics.errors().next() {
        return Err(Error::Parse(format!("{filename}: {error}")));
    }
    let semantic = SemanticBuilder::new().with_build_nodes(true).build(&parsed.program).semantic;
    let lines = LineIndex::new(source);
    let mut output = CheckOutput::default();
    for usage in globals::detect(&semantic) {
        record(&mut output, usage, Confidence::Exact, filename, targets, allow, &lines);
    }
    // Detectors walk hash maps, so the order of their output is not stable.
    output.findings.sort_by_key(|finding| (finding.start.line, finding.start.column));
    output.used_allow.sort_unstable();
    output.used_allow.dedup();
    Ok(output)
}

fn record(
    output: &mut CheckOutput,
    usage: Use,
    confidence: Confidence,
    filename: &str,
    targets: &Targets,
    allow: &AllowList,
    lines: &LineIndex<'_>,
) {
    let (confidence, gaps) = match evaluate(usage.feature, targets) {
        Verdict::Supported => return,
        Verdict::Unsupported(gaps) => (confidence, gaps),
        Verdict::Partial(gaps) => (Confidence::Partial, gaps),
    };
    if let Some(index) = allow.find(usage.feature.as_str(), filename) {
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
