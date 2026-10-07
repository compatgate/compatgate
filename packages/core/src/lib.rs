//! Node binding of the compatgate core.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use compatgate::allow::{AllowEntry, AllowIssue, AllowList, validate_allow as validate_entries};
use compatgate::data::{BCD_VERSION, format_version};
use compatgate::support::Gap;
use compatgate::targets::Targets;
use compatgate::{Confidence, Finding, Kind};
use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi(object)]
pub struct AllowEntryInput {
    pub feature: String,
    pub packages: Option<Vec<String>>,
    pub files: Option<Vec<String>>,
    pub base_dir: Option<String>,
}

#[napi(object)]
pub struct CheckInput {
    pub filename: String,
    pub targets: String,
    pub allow: Option<Vec<AllowEntryInput>>,
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
}

#[napi(object)]
pub struct FindingOutput {
    pub feature: String,
    pub kind: String,
    pub confidence: String,
    pub start: PositionOutput,
    pub end: PositionOutput,
    pub unsupported: Vec<GapOutput>,
}

#[napi(object)]
pub struct CheckResultOutput {
    pub findings: Vec<FindingOutput>,
    pub used_allow: Vec<u32>,
    pub ignored_browsers: Vec<String>,
}

#[napi(object)]
pub struct AllowIssueOutput {
    pub index: u32,
    pub kind: String,
}

// Linters call check() once per file with the same query, and resolving a query walks the caniuse data.
static TARGETS: LazyLock<Mutex<HashMap<String, Arc<Targets>>>> = LazyLock::new(Default::default);

fn targets(query: &str) -> Result<Arc<Targets>> {
    let mut cache = TARGETS
        .lock()
        .map_err(|_| Error::new(Status::GenericFailure, "compatgate: the targets cache is poisoned"))?;
    if let Some(targets) = cache.get(query) {
        return Ok(Arc::clone(targets));
    }
    let resolved = Arc::new(Targets::resolve(query).map_err(to_napi)?);
    cache.insert(query.to_string(), Arc::clone(&resolved));
    Ok(resolved)
}

fn to_napi(error: compatgate::Error) -> Error {
    Error::new(Status::InvalidArg, format!("compatgate: {error}"))
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

#[napi]
pub fn check(source: String, input: CheckInput) -> Result<CheckResultOutput> {
    let targets = targets(&input.targets)?;
    let allow = AllowList::new(&entries(input.allow.unwrap_or_default())).map_err(to_napi)?;
    let output = compatgate::check(&source, &input.filename, &targets, &allow).map_err(to_napi)?;
    Ok(CheckResultOutput {
        findings: output.findings.into_iter().map(finding).collect(),
        used_allow: output.used_allow.into_iter().map(|index| index as u32).collect(),
        ignored_browsers: targets.ignored().to_vec(),
    })
}

#[napi]
pub fn validate_allow(allow: Vec<AllowEntryInput>, targets_query: String) -> Result<Vec<AllowIssueOutput>> {
    let targets = targets(&targets_query)?;
    Ok(validate_entries(&entries(allow), &targets)
        .into_iter()
        .map(|issue| match issue {
            AllowIssue::UnknownFeature { index } => AllowIssueOutput { index: index as u32, kind: "unknown-feature".into() },
            AllowIssue::NativeInTargets { index } => AllowIssueOutput { index: index as u32, kind: "native-in-targets".into() },
        })
        .collect())
}

#[napi]
pub fn bcd_version() -> String {
    BCD_VERSION.to_string()
}

fn finding(finding: Finding) -> FindingOutput {
    FindingOutput {
        feature: finding.feature.to_string(),
        kind: match finding.kind {
            Kind::Syntax => "syntax",
            Kind::Builtin => "builtin",
            Kind::Api => "api",
        }
        .into(),
        confidence: match finding.confidence {
            Confidence::Exact => "exact",
            Confidence::Heuristic => "heuristic",
            Confidence::Partial => "partial",
        }
        .into(),
        start: PositionOutput { line: finding.start.line, column: finding.start.column },
        end: PositionOutput { line: finding.end.line, column: finding.end.column },
        unsupported: finding.gaps.into_iter().map(gap).collect(),
    }
}

fn gap(gap: Gap) -> GapOutput {
    GapOutput {
        browser: gap.browser.bcd_key().to_string(),
        target: format_version(gap.target),
        since: gap.since.map(format_version),
    }
}
