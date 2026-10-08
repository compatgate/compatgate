//! Node binding of the compatgate core.

use std::panic::{AssertUnwindSafe, catch_unwind};

use compatgate::allow::{AllowEntry, AllowIssue, AllowList, validate_allow as validate_entries};
use compatgate::data::{BCD_VERSION, format_version};
use compatgate::position::Position;
use compatgate::support::Gap;
use compatgate::targets::Targets;
use compatgate::{Confidence, Finding, Kind, ParseError};
use napi_derive::napi;

/// The `code` of a JavaScript error that the binding throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// The browserslist query is invalid.
    Targets,
    /// An `allow` entry is invalid.
    Allow,
    /// The core panicked. It is a bug in compatgate, not in the checked code.
    Internal,
}

impl AsRef<str> for Code {
    fn as_ref(&self) -> &str {
        match self {
            Code::Targets => "COMPATGATE_TARGETS",
            Code::Allow => "COMPATGATE_ALLOW",
            Code::Internal => "COMPATGATE_INTERNAL",
        }
    }
}

type Result<T> = napi::Result<T, Code>;

fn to_napi(error: compatgate::Error) -> napi::Error<Code> {
    let code = match error {
        compatgate::Error::Targets(_) => Code::Targets,
        compatgate::Error::Allow(_) => Code::Allow,
        // `check` returns these in the result, so they never get here.
        compatgate::Error::Parse(_) | compatgate::Error::UnsupportedFile(_) => Code::Internal,
    };
    napi::Error::new(code, format!("compatgate: {error}"))
}

/// Turns a panic of the core into an error with `COMPATGATE_INTERNAL`, so that the linter or the bundler
/// of the user keeps running. `#[napi(catch_unwind)]` would give the generic `GenericFailure` code.
fn guard<T>(run: impl FnOnce() -> Result<T>) -> Result<T> {
    catch_unwind(AssertUnwindSafe(run)).unwrap_or_else(|payload| {
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or("unknown panic");
        Err(napi::Error::new(
            Code::Internal,
            format!("compatgate: internal error: {message}"),
        ))
    })
}

#[napi(object)]
pub struct AllowEntryInput {
    pub feature: String,
    pub packages: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
    pub base_dir: Option<String>,
}

#[napi(object)]
pub struct PositionOutput {
    pub line: u32,
    pub column: u32,
}

#[napi(object)]
pub struct GapOutput {
    pub browser: String,
    pub target: String,
    pub since: Option<String>,
    pub note: Option<String>,
}

#[napi(string_enum = "lowercase")]
pub enum FindingKind {
    Syntax,
    Builtin,
    Api,
}

#[napi(string_enum = "lowercase")]
pub enum FindingConfidence {
    Exact,
    Heuristic,
    Partial,
}

#[napi(object)]
pub struct FindingOutput {
    pub feature: String,
    pub kind: FindingKind,
    pub confidence: FindingConfidence,
    pub alternatives: Vec<String>,
    pub start: PositionOutput,
    pub end: PositionOutput,
    pub range: (u32, u32),
    pub unsupported: Vec<GapOutput>,
}

#[napi(string_enum)]
pub enum ParseErrorKind {
    /// The source has a syntax error.
    #[napi(value = "syntax")]
    Syntax,
    /// The extension of the filename selects no parser.
    #[napi(value = "unsupported-file")]
    UnsupportedFile,
}

#[napi(object)]
pub struct ParseErrorOutput {
    pub kind: ParseErrorKind,
    pub message: String,
    /// Set for a syntax error only.
    pub line: Option<u32>,
    /// Set for a syntax error only.
    pub column: Option<u32>,
}

#[napi(object)]
pub struct CheckResultOutput {
    pub findings: Vec<FindingOutput>,
    pub used_allow: Vec<u32>,
    pub ignored_browsers: Vec<String>,
    pub parse_error: Option<ParseErrorOutput>,
}

#[napi(string_enum)]
pub enum AllowIssueKind {
    #[napi(value = "unknown-feature")]
    UnknownFeature,
    #[napi(value = "native-in-targets")]
    NativeInTargets,
}

#[napi(object)]
pub struct AllowIssueOutput {
    pub index: u32,
    pub kind: AllowIssueKind,
}

/// Resolved targets and compiled `allow` entries. One checker serves every file of a project: the
/// query, the support table and the globs are built once. The checker never changes after `new`, so
/// the checkers of several workers run at the same time without locks.
#[napi]
pub struct Checker {
    targets: Targets,
    allow: AllowList,
}

#[napi]
impl Checker {
    /// Throws an error with the code `COMPATGATE_TARGETS` or `COMPATGATE_ALLOW`.
    #[napi(constructor)]
    pub fn new(targets: String, allow: Option<Vec<AllowEntryInput>>) -> Result<Self> {
        guard(|| {
            Ok(Self {
                targets: Targets::resolve(&targets).map_err(to_napi)?,
                allow: AllowList::new(&entries(allow.unwrap_or_default())).map_err(to_napi)?,
            })
        })
    }

    /// A source that does not parse gives no findings and a `parseError`: a linter shows its own parse
    /// errors, and a bundler skips the module.
    #[napi]
    pub fn check(&self, source: String, filename: String) -> Result<CheckResultOutput> {
        guard(|| {
            let ignored_browsers = self.targets.ignored().to_vec();
            Ok(
                match compatgate::check(&source, &filename, &self.targets, &self.allow) {
                    Ok(output) => CheckResultOutput {
                        findings: output.findings.into_iter().map(finding).collect(),
                        used_allow: output.used_allow.into_iter().map(|index| index as u32).collect(),
                        ignored_browsers,
                        parse_error: None,
                    },
                    Err(compatgate::Error::Parse(error)) => CheckResultOutput {
                        findings: Vec::new(),
                        used_allow: Vec::new(),
                        ignored_browsers,
                        parse_error: Some(parse_error(error)),
                    },
                    Err(compatgate::Error::UnsupportedFile(message)) => CheckResultOutput {
                        findings: Vec::new(),
                        used_allow: Vec::new(),
                        ignored_browsers,
                        parse_error: Some(ParseErrorOutput {
                            kind: ParseErrorKind::UnsupportedFile,
                            message,
                            line: None,
                            column: None,
                        }),
                    },
                    Err(error) => return Err(to_napi(error)),
                },
            )
        })
    }
}

fn entries(input: Vec<AllowEntryInput>) -> Vec<AllowEntry> {
    input
        .into_iter()
        .map(|entry| AllowEntry {
            feature: entry.feature,
            packages: entry.packages.unwrap_or_default(),
            files: entry.files.unwrap_or_default(),
            base_dir: entry.base_dir.unwrap_or_default(),
        })
        .collect()
}

/// Resolves the query on every call: a project validates its entries once, not per file.
#[napi]
pub fn validate_allow(allow: Vec<AllowEntryInput>, targets_query: String) -> Result<Vec<AllowIssueOutput>> {
    guard(|| {
        let targets = Targets::resolve(&targets_query).map_err(to_napi)?;
        Ok(validate_entries(&entries(allow), &targets)
            .into_iter()
            .map(|issue| match issue {
                AllowIssue::UnknownFeature { index } => AllowIssueOutput {
                    index: index as u32,
                    kind: AllowIssueKind::UnknownFeature,
                },
                AllowIssue::NativeInTargets { index } => AllowIssueOutput {
                    index: index as u32,
                    kind: AllowIssueKind::NativeInTargets,
                },
            })
            .collect())
    })
}

/// Whether `Checker.check` can parse a file with this name. A bundler id with a query (`a.ts?v=1`)
/// is no file name: the adapter strips the query first.
#[napi]
pub fn is_checkable(filename: String) -> bool {
    compatgate::is_checkable(&filename)
}

#[napi]
pub fn bcd_version() -> String {
    BCD_VERSION.to_string()
}

impl From<Kind> for FindingKind {
    fn from(kind: Kind) -> Self {
        match kind {
            Kind::Syntax => FindingKind::Syntax,
            Kind::Builtin => FindingKind::Builtin,
            Kind::Api => FindingKind::Api,
        }
    }
}

impl From<Confidence> for FindingConfidence {
    fn from(confidence: Confidence) -> Self {
        match confidence {
            Confidence::Exact => FindingConfidence::Exact,
            Confidence::Heuristic => FindingConfidence::Heuristic,
            Confidence::Partial => FindingConfidence::Partial,
        }
    }
}

fn position(position: Position) -> PositionOutput {
    PositionOutput {
        line: position.line,
        column: position.column,
    }
}

fn finding(finding: Finding) -> FindingOutput {
    FindingOutput {
        feature: finding.feature.to_string(),
        kind: finding.kind.into(),
        confidence: finding.confidence.into(),
        alternatives: finding.alternatives.iter().map(|id| id.as_str().to_string()).collect(),
        start: position(finding.start),
        end: position(finding.end),
        range: (finding.start.offset, finding.end.offset),
        unsupported: finding.gaps.into_iter().map(gap).collect(),
    }
}

fn parse_error(error: ParseError) -> ParseErrorOutput {
    ParseErrorOutput {
        kind: ParseErrorKind::Syntax,
        message: error.message,
        line: Some(error.position.line),
        column: Some(error.position.column),
    }
}

fn gap(gap: Gap) -> GapOutput {
    GapOutput {
        browser: gap.browser.bcd_key().to_string(),
        target: format_version(gap.target),
        since: gap.since.map(format_version),
        note: gap.note.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_becomes_an_internal_error() {
        let error = guard::<()>(|| panic!("boom")).unwrap_err();
        assert_eq!(error.status, Code::Internal);
        assert_eq!(error.reason, "compatgate: internal error: boom");
        let error = guard::<()>(|| panic!("{}", String::from("formatted"))).unwrap_err();
        assert_eq!(error.reason, "compatgate: internal error: formatted");
    }

    #[test]
    fn configuration_errors_keep_their_codes() {
        let targets = Checker::new("Chrom >= 97".into(), None).err().unwrap();
        assert_eq!(targets.status, Code::Targets);
        let allow = Checker::new(
            "Chrome >= 97".into(),
            Some(vec![AllowEntryInput {
                feature: "api.a".into(),
                packages: None,
                files: Some(vec!["src/[a".into()]),
                base_dir: Some("/p".into()),
            }]),
        )
        .err()
        .unwrap();
        assert_eq!(allow.status, Code::Allow);
    }

    #[test]
    fn the_codes_are_the_documented_strings() {
        let codes: Vec<&str> = [Code::Targets, Code::Allow, Code::Internal]
            .iter()
            .map(AsRef::as_ref)
            .collect();
        assert_eq!(codes, ["COMPATGATE_TARGETS", "COMPATGATE_ALLOW", "COMPATGATE_INTERNAL"]);
    }
}
