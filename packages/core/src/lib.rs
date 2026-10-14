//! Node binding of the compatgate core.

use std::panic::{AssertUnwindSafe, catch_unwind};

use compatgate::allow::{AllowEntry, AllowIssue, AllowList, validate_allow};
use compatgate::data::{BCD_VERSION, format_version};
use compatgate::position::Position;
use compatgate::support::Gap;
use compatgate::targets::Targets;
use compatgate::{Confidence, Finding, Kind, ParseError};
use napi_derive::napi;

/// The `code` of a JavaScript error that the binding throws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    /// The browsers of the targets are invalid or have no compatibility data.
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
pub struct SuppressionOutput {
    pub index: u32,
    pub kind: FindingKind,
}

#[napi(object)]
pub struct CheckResultOutput {
    pub findings: Vec<FindingOutput>,
    pub suppressed: Vec<SuppressionOutput>,
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
    /// The closest known id for an unknown one, such as `api.fetch` for `api.fetchh`.
    pub suggestion: Option<String>,
}

/// Resolved targets and compiled `allow` entries. One checker serves every file of a project: the
/// support table and the globs are built once. The checker never changes after `new`, so
/// the checkers of several workers run at the same time without locks.
#[napi]
pub struct Checker {
    targets: Targets,
    allow: AllowList,
    /// The entries as given, for `issues`: the compiled list keeps no more than a check needs.
    entries: Vec<AllowEntry>,
}

#[napi]
impl Checker {
    /// `targets` are the browsers that the `browserslist` npm package returns: `['chrome 120', 'safari 15.6-15.8']`.
    /// Throws an error with the code `COMPATGATE_TARGETS` or `COMPATGATE_ALLOW`.
    #[napi(constructor)]
    pub fn new(targets: Vec<String>, allow: Option<Vec<AllowEntryInput>>) -> Result<Self> {
        guard(|| {
            let entries = entries(allow.unwrap_or_default());
            let browsers: Vec<&str> = targets.iter().map(String::as_str).collect();
            Ok(Self {
                targets: Targets::from_browserslist(&browsers).map_err(to_napi)?,
                allow: AllowList::new(&entries).map_err(to_napi)?,
                entries,
            })
        })
    }

    /// The entries with an unknown feature id and the entries that every target supports. The checker
    /// has resolved the targets already, so a caller asks it instead of resolving them again.
    #[napi]
    pub fn issues(&self) -> Result<Vec<AllowIssueOutput>> {
        guard(|| {
            Ok(validate_allow(&self.entries, &self.targets)
                .into_iter()
                .map(|issue| match issue {
                    AllowIssue::UnknownFeature { index, suggestion } => AllowIssueOutput {
                        index: index as u32,
                        kind: AllowIssueKind::UnknownFeature,
                        suggestion: suggestion.map(String::from),
                    },
                    AllowIssue::NativeInTargets { index } => AllowIssueOutput {
                        index: index as u32,
                        kind: AllowIssueKind::NativeInTargets,
                        suggestion: None,
                    },
                })
                .collect())
        })
    }

    /// browserslist names in the targets that compatgate has no data for. A property of the targets,
    /// not of a checked file.
    #[napi(getter)]
    pub fn ignored_browsers(&self) -> Vec<String> {
        self.targets.ignored().to_vec()
    }

    /// A source that does not parse gives no findings and a `parseError`: a linter shows its own parse
    /// errors, and a bundler skips the module. `parse_as` selects the parser by its extension instead
    /// of `filename`; `filename` still matches the `files` and `packages` of the entries.
    #[napi]
    pub fn check(&self, source: String, filename: String, parse_as: Option<String>) -> Result<CheckResultOutput> {
        guard(|| {
            let parse_as = parse_as.as_deref().unwrap_or(&filename);
            Ok(
                match compatgate::check_as(&source, &filename, parse_as, &self.targets, &self.allow) {
                    Ok(output) => CheckResultOutput {
                        findings: output.findings.into_iter().map(finding).collect(),
                        suppressed: output
                            .suppressed
                            .into_iter()
                            .map(|(index, kind)| SuppressionOutput {
                                index: index as u32,
                                kind: kind.into(),
                            })
                            .collect(),
                        parse_error: None,
                    },
                    Err(compatgate::Error::Parse(error)) => CheckResultOutput {
                        findings: Vec::new(),
                        suppressed: Vec::new(),
                        parse_error: Some(parse_error(error)),
                    },
                    Err(compatgate::Error::UnsupportedFile(message)) => CheckResultOutput {
                        findings: Vec::new(),
                        suppressed: Vec::new(),
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

    fn browsers(list: &[&str]) -> Vec<String> {
        list.iter().map(|entry| entry.to_string()).collect()
    }

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
        let targets = Checker::new(browsers(&["op_mini all"]), None).err().unwrap();
        assert_eq!(targets.status, Code::Targets);
        let allow = Checker::new(
            browsers(&["chrome 97"]),
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
    fn a_checker_reports_the_issues_of_its_entries_and_the_ignored_browsers() {
        let entry = |feature: &str| AllowEntryInput {
            feature: feature.into(),
            packages: None,
            files: None,
            base_dir: None,
        };
        let checker = Checker::new(
            browsers(&["chrome 120", "chrome 97", "op_mini all", "ie 11"]),
            Some(vec![
                entry("api.DoesNotExist"),
                entry("api.structuredClone"),
                entry("api.fetch"),
                entry("api.URL.canParse"),
            ]),
        )
        .unwrap();
        let issues: Vec<(u32, bool, Option<String>)> = checker
            .issues()
            .unwrap()
            .into_iter()
            .map(|issue| {
                let unknown = matches!(issue.kind, AllowIssueKind::UnknownFeature);
                (issue.index, unknown, issue.suggestion)
            })
            .collect();
        assert_eq!(
            issues,
            [
                (0, true, None),
                (2, false, None),
                (3, true, Some("api.URL.canParse_static".into()))
            ]
        );
        assert_eq!(checker.ignored_browsers(), ["ie"]);
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
