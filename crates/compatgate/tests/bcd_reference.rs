//! Checks the compressed support tables against BCD itself. The test reads the statements of every
//! feature from `@mdn/browser-compat-data` in node_modules and evaluates them version by version: for
//! each target browser, every released version from the lowest target version on has full, partial or
//! no support.
//! From that it builds the expected masks, verdict, gaps, `since` and notes, and compares them with
//! `Targets` and `support::evaluate` for every feature under several queries.
//!
//! The reference shares no code with scripts/generate-data.js or with the range logic in `data.rs`.
//! It reads the BCD rules from scratch: statements behind a flag, a prefix or an old name do not count,
//! "≤N" is N, a removal in a preview build or in a release that is not out yet is no removal, and a
//! `version_added` of false, null or "preview" is no support. `versions` tells which releases it checks.
//!
//! The test needs `pnpm install`: it reads BCD from node_modules instead of a fixture in the repository.

use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;
use std::path::Path;
use std::sync::OnceLock;

use compatgate::data::{BCD_VERSION, Browser, FeatureId, Support, format_version};
use compatgate::support::{Verdict, evaluate};
use compatgate::targets::Targets;
use serde_json::Value;

const QUERIES: [&str; 5] = [
    // The targets of the corpus and the unit tests.
    "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115",
    // The targets of a project without a browserslist config.
    "defaults",
    "Chrome >= 40, Safari >= 9, Firefox >= 30, Samsung >= 4",
    "last 2 years",
    // One mobile browser, with many releases in browserslist-rs.
    "iOS >= 15",
];

/// No version: the removal of support that lasts, and `since` of support that does not.
const NONE: u32 = u32::MAX;

/// At most this many differences are printed. The message gives the count of all of them.
const SHOWN: usize = 40;

/// Both tests read BCD once: the JSON takes most of the time.
fn bcd() -> &'static Bcd {
    static BCD: OnceLock<Bcd> = OnceLock::new();
    BCD.get_or_init(Bcd::load)
}

#[test]
fn targets_match_bcd_version_by_version() {
    let mut differences = Vec::new();
    for query in QUERIES {
        check_query(bcd(), query, &mut differences);
    }
    assert_no_differences(&differences);
}

/// `support_from` for every release of every browser as the target, not only the lowest target versions
/// of the queries. A range that ends at a wrong version changes no verdict of a query whose target is
/// before both versions, but it changes `support_from` for the targets between them.
#[test]
fn support_from_every_release_matches_bcd() {
    let bcd = bcd();
    let mut differences = Vec::new();
    for feature in &bcd.features {
        let id = FeatureId::find(&feature.id).unwrap();
        for browser in Browser::ALL {
            let statements = &feature.statements[browser.index()];
            let versions = &bcd.versions[browser.index()];
            // Levels of the suffixes of `versions`, from the latest: the first version without support
            // and the first with partial support only, from each version on. One wrong range spoils
            // many targets, so the message names the earliest of them and counts the rest.
            let (mut missing, mut partial) = (None, None);
            let (mut earliest, mut count) = (None, 0);
            for (index, &version) in versions.iter().enumerate().rev() {
                match support_at(statements, version) {
                    Some(true) => {}
                    Some(false) => partial = Some(version),
                    None => missing = Some(version),
                }
                let level = match (missing, partial) {
                    (Some(first), _) => Level::Missing(first),
                    (None, Some(first)) => Level::Partial(first),
                    (None, None) => Level::Full,
                };
                let found = id.support_from(browser, version);
                let problem = match (found, level) {
                    (Support::Full, Level::Full) | (Support::Missing, Level::Missing(_)) => continue,
                    (Support::Partial(note), Level::Partial(first)) => match check_note(note, statements, first) {
                        Ok(()) => continue,
                        Err(problem) => format!("from {}: {problem}", show(version)),
                    },
                    _ => format!("from {}: support_from says {found:?}, BCD says {level}", show(version)),
                };
                earliest = Some((index, problem));
                count += 1;
            }
            if let Some((index, mut problem)) = earliest {
                if count > 1 {
                    let _ = write!(problem, ", and so in {} later targets", count - 1);
                }
                let context = Context {
                    query: "every release",
                    feature,
                    browser,
                    versions: &versions[index..],
                };
                differences.push(context.describe(&problem));
            }
        }
    }
    assert_no_differences(&differences);
}

fn assert_no_differences(differences: &[String]) {
    let shown = differences.len().min(SHOWN);
    assert!(
        differences.is_empty(),
        "{} differences between the core and BCD, {shown} shown:\n{}",
        differences.len(),
        differences[..shown].join("\n")
    );
}

fn check_query(bcd: &Bcd, query: &str, differences: &mut Vec<String>) {
    let targets = Targets::resolve(query).unwrap();
    let minimum = lowest_versions(query);
    assert_eq!(
        targets.minimum(),
        minimum.as_slice(),
        "{query}: the lowest target versions"
    );
    let versions: Vec<Vec<u32>> = minimum
        .iter()
        .map(|&(browser, target)| bcd.versions_from(browser, target))
        .collect();
    let (mut unsupported, mut partial) = (0, 0);
    for feature in &bcd.features {
        let id = FeatureId::find(&feature.id).unwrap();
        let levels: Vec<Level> = minimum
            .iter()
            .zip(&versions)
            .map(|(&(browser, _), versions)| Level::new(&feature.statements[browser.index()], versions))
            .collect();
        let context = |index: usize| Context {
            query,
            feature,
            browser: minimum[index].0,
            versions: &versions[index],
        };
        // The masks first: the verdict follows from them, and a wrong mask would repeat in the gaps.
        let support = targets.support(id);
        let mut masks_match = true;
        for (index, (&(browser, _), level)) in minimum.iter().zip(&levels).enumerate() {
            let core = if support.missing.contains(browser) {
                "missing"
            } else if support.partial.contains(browser) {
                "partial"
            } else {
                "full"
            };
            if core != level.name() {
                masks_match = false;
                differences.push(context(index).describe(&format!("the masks say {core}, BCD says {level}")));
            }
        }
        if !masks_match {
            continue;
        }
        let any_missing = levels.iter().any(|level| matches!(level, Level::Missing(_)));
        let gap_indices: Vec<usize> = (0..levels.len())
            .filter(|&index| match levels[index] {
                Level::Missing(_) => true,
                Level::Partial(_) => !any_missing,
                Level::Full => false,
            })
            .collect();
        let verdict = evaluate(id, &targets);
        let gaps = match &verdict {
            Verdict::Supported if gap_indices.is_empty() => continue,
            Verdict::Unsupported(gaps) if any_missing => {
                unsupported += 1;
                gaps
            }
            Verdict::Partial(gaps) if !any_missing && !gap_indices.is_empty() => {
                partial += 1;
                gaps
            }
            _ => {
                let expected = if any_missing {
                    "unsupported"
                } else if gap_indices.is_empty() {
                    "supported"
                } else {
                    "partial"
                };
                let mut text = format!(
                    "{query} | {}: the verdict is {verdict:?}, BCD gives {expected}",
                    feature.id
                );
                for &index in &gap_indices {
                    let _ = write!(
                        text,
                        "\n  {}",
                        context(index).describe(&format!("BCD says {}", levels[index]))
                    );
                }
                differences.push(text);
                continue;
            }
        };
        let expected: Vec<(Browser, u32)> = gap_indices.iter().map(|&index| minimum[index]).collect();
        let found: Vec<(Browser, u32)> = gaps.iter().map(|gap| (gap.browser, gap.target)).collect();
        if found != expected {
            differences.push(format!(
                "{query} | {}: the gaps name {found:?}, BCD gives {expected:?}",
                feature.id
            ));
            continue;
        }
        for (gap, &index) in gaps.iter().zip(&gap_indices) {
            let statements = &feature.statements[gap.browser.index()];
            let since = lasting_full_support(statements);
            let found = gap.since.unwrap_or(NONE);
            if found != since {
                differences.push(context(index).describe(&format!(
                    "since is {}, BCD gives {}",
                    show(found),
                    show(since)
                )));
            }
            let note = match levels[index] {
                Level::Partial(version) => Some(version),
                _ => None,
            };
            if let Some(version) = note
                && let Err(problem) = check_note(gap.note, statements, version)
            {
                differences.push(context(index).describe(&problem));
            } else if note.is_none() && gap.note.is_some() {
                differences.push(
                    context(index).describe(&format!("a gap without partial support has the note {:?}", gap.note)),
                );
            }
        }
    }
    // A reference that finds no gap compares nothing. Every query has both kinds of verdicts.
    if unsupported <= 100 || partial <= 10 {
        differences.push(format!(
            "{query}: only {unsupported} unsupported and {partial} partial verdicts match BCD"
        ));
    }
}

/// Support of a feature in the versions of a browser from the target on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Level {
    Full,
    /// Every version has support and this one, the first such, only partial support.
    Partial(u32),
    /// This version, the first such, has no support.
    Missing(u32),
}

impl Level {
    fn new(statements: &[Statement], versions: &[u32]) -> Self {
        let mut first_partial = None;
        for &version in versions {
            match support_at(statements, version) {
                Some(true) => {}
                Some(false) => {
                    first_partial.get_or_insert(version);
                }
                None => return Level::Missing(version),
            }
        }
        first_partial.map_or(Level::Full, Level::Partial)
    }

    fn name(self) -> &'static str {
        match self {
            Level::Full => "full",
            Level::Partial(_) => "partial",
            Level::Missing(_) => "missing",
        }
    }
}

impl std::fmt::Display for Level {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Level::Full => write!(formatter, "full in every version"),
            Level::Partial(version) => write!(formatter, "partial, first in {}", show(version)),
            Level::Missing(version) => write!(formatter, "missing, first in {}", show(version)),
        }
    }
}

/// `Some(true)` for full support in `version`, `Some(false)` for partial support only, `None` for none.
fn support_at(statements: &[Statement], version: u32) -> Option<bool> {
    let covering = statements
        .iter()
        .filter(|statement| statement.added <= version && version < statement.removed);
    let mut any = false;
    for statement in covering {
        if !statement.partial {
            return Some(true);
        }
        any = true;
    }
    any.then_some(false)
}

/// The first version from which full support lasts to the latest release, or `NONE`. Support changes
/// only at the versions that the statements name, so the test checks those versions, latest first.
fn lasting_full_support(statements: &[Statement]) -> u32 {
    let boundaries: BTreeSet<u32> = statements
        .iter()
        .flat_map(|statement| [statement.added, statement.removed])
        .filter(|&version| version != NONE)
        .collect();
    let mut since = NONE;
    for &version in boundaries.iter().rev() {
        if support_at(statements, version) != Some(true) {
            break;
        }
        since = version;
    }
    since
}

/// The note of partial support describes the first version with partial support only: it is the note
/// of the partial statements that cover that version. Statements that disagree on it leave the choice
/// to the order of the data, so they are a difference too.
fn check_note(note: Option<&str>, statements: &[Statement], version: u32) -> Result<(), String> {
    let candidates: BTreeSet<Option<&str>> = statements
        .iter()
        .filter(|statement| statement.partial && statement.added <= version && version < statement.removed)
        .map(|statement| statement.note.as_deref())
        .collect();
    let mut candidates = candidates.into_iter();
    match (candidates.next(), candidates.next()) {
        (Some(expected), None) if expected == note => Ok(()),
        (Some(expected), None) => Err(format!(
            "the note is {note:?}, BCD gives {expected:?} for {}",
            show(version)
        )),
        (None, _) => Err(format!("no partial statement covers {}", show(version))),
        (Some(first), Some(second)) => Err(format!(
            "the partial statements that cover {} disagree on the note: {first:?}, {second:?}{}; the core gives {note:?}",
            show(version),
            if candidates.len() > 0 { " and more" } else { "" }
        )),
    }
}

struct Context<'a> {
    query: &'a str,
    feature: &'a Feature,
    browser: Browser,
    versions: &'a [u32],
}

impl Context<'_> {
    /// A difference with the BCD statements and the checked versions that explain it.
    fn describe(&self, problem: &str) -> String {
        let mut text = format!(
            "{} | {} | {}: {problem}\n    statements:",
            self.query,
            self.feature.id,
            self.browser.bcd_key()
        );
        let statements = &self.feature.statements[self.browser.index()];
        if statements.is_empty() {
            text.push_str(" none");
        }
        for (index, statement) in statements.iter().enumerate() {
            let _ = write!(
                text,
                "{} [{}, {}){}",
                if index == 0 { "" } else { "," },
                show(statement.added),
                show(statement.removed),
                if statement.partial { " partial" } else { "" }
            );
        }
        let mut versions: Vec<String> = self.versions.iter().map(|&version| show(version)).collect();
        // The start of the list explains most differences, and the end shows how far it goes.
        if versions.len() > 24 {
            let hidden = versions.len() - 20;
            versions.splice(16..versions.len() - 4, [format!("({hidden} more)")]);
        }
        let _ = write!(text, "\n    versions: {}", versions.join(" "));
        text
    }
}

fn show(version: u32) -> String {
    if version == NONE {
        "-".to_string()
    } else {
        format_version(version)
    }
}

/// The lowest version of each browser that the query selects, straight from browserslist-rs.
fn lowest_versions(query: &str) -> Vec<(Browser, u32)> {
    let mut lowest: HashMap<Browser, u32> = HashMap::new();
    for distrib in browserslist::resolve([query], &browserslist::Opts::default()).unwrap() {
        let Some(browser) = browser(distrib.name()) else {
            continue;
        };
        // The core takes the lower bound of a range such as "18.5-18.7". "TP" is no version.
        if let Some(&version) = browserslist_versions(distrib.version()).first() {
            let entry = lowest.entry(browser).or_insert(version);
            *entry = (*entry).min(version);
        }
    }
    let mut lowest: Vec<(Browser, u32)> = lowest.into_iter().collect();
    lowest.sort();
    lowest
}

/// browserslist names and BCD keys of the browsers with data.
const NAMES: [(&str, &str); 11] = [
    ("chrome", "chrome"),
    ("and_chr", "chrome_android"),
    ("edge", "edge"),
    ("firefox", "firefox"),
    ("and_ff", "firefox_android"),
    ("opera", "opera"),
    ("op_mob", "opera_android"),
    ("safari", "safari"),
    ("ios_saf", "safari_ios"),
    ("samsung", "samsunginternet_android"),
    ("android", "webview_android"),
];

fn browser(browserslist_name: &str) -> Option<Browser> {
    let key = NAMES.iter().find(|(name, _)| *name == browserslist_name)?.1;
    Browser::ALL.into_iter().find(|browser| browser.bcd_key() == key)
}

/// The versions of a browserslist entry: "18.5-18.7" stands for two releases, the first and the last.
/// "TP" is no release.
fn browserslist_versions(text: &str) -> Vec<u32> {
    text.split('-').filter_map(parse_version).collect()
}

/// "1", "1.2" and "1.2.3" as `major << 16 | minor << 8 | patch`, the encoding of the core.
fn parse_version(text: &str) -> Option<u32> {
    let mut parts = text.split('.').map(|part| part.parse::<u32>().ok());
    let major = parts.next()??;
    let minor = parts.next().unwrap_or(Some(0))?;
    let patch = parts.next().unwrap_or(Some(0))?;
    (parts.next().is_none() && major <= 0xffff && minor <= 0xff && patch <= 0xff)
        .then_some(major << 16 | minor << 8 | patch)
}

/// A usable BCD statement: support in `[added, removed)`.
struct Statement {
    added: u32,
    removed: u32,
    partial: bool,
    note: Option<String>,
}

struct Feature {
    id: String,
    /// Usable statements, indexed by `Browser::index`.
    statements: Vec<Vec<Statement>>,
}

struct Bcd {
    features: Vec<Feature>,
    /// The versions to check for each browser, indexed by `Browser::index`, sorted. See `versions`.
    versions: Vec<Vec<u32>>,
}

impl Bcd {
    fn load() -> Self {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/@mdn/browser-compat-data");
        let read = |name: &str| {
            let text = std::fs::read_to_string(package.join(name))
                .unwrap_or_else(|error| panic!("{}: {error}. Run `pnpm install`.", package.join(name).display()));
            serde_json::from_str::<Value>(&text).unwrap()
        };
        let version = read("package.json")["version"].as_str().unwrap().to_string();
        assert_eq!(
            version, BCD_VERSION,
            "node_modules has BCD {version}, the tables come from BCD {BCD_VERSION}"
        );
        let data = read("data.json");
        let releases: Vec<Releases> = Browser::ALL
            .iter()
            .map(|browser| Releases::new(browser.bcd_key(), &data["browsers"][browser.bcd_key()]["releases"]))
            .collect();
        let mut features = Vec::new();
        collect(&data["api"], "api", &releases, &mut features);
        collect(&data["javascript"], "javascript", &releases, &mut features);
        let ids: BTreeSet<&str> = features.iter().map(|feature| feature.id.as_str()).collect();
        let core: BTreeSet<&str> = compatgate::data::feature_ids().collect();
        assert_eq!(ids, core, "the features of BCD and of the tables");
        Self {
            features,
            versions: Browser::ALL
                .iter()
                .map(|&browser| versions(browser, &releases[browser.index()]))
                .collect(),
        }
    }

    /// The versions of `browser` from `target` on.
    fn versions_from(&self, browser: Browser, target: u32) -> Vec<u32> {
        self.versions[browser.index()]
            .iter()
            .copied()
            .filter(|&version| version >= target)
            .collect()
    }
}

/// The releases of a browser in BCD, split by whether they are out.
struct Releases {
    /// Status "current", "retired" or "esr".
    released: BTreeSet<u32>,
    /// Any other status: "beta", "nightly", "planned".
    unreleased: BTreeSet<u32>,
}

impl Releases {
    fn new(key: &str, releases: &Value) -> Self {
        let Value::Object(releases) = releases else {
            panic!("{key}: BCD has no releases");
        };
        let mut split = Self {
            released: BTreeSet::new(),
            unreleased: BTreeSet::new(),
        };
        for (version, release) in releases {
            let encoded = parse_version(version).unwrap_or_else(|| panic!("{key}: release {version:?}"));
            match release["status"].as_str() {
                Some("current" | "retired" | "esr") => split.released.insert(encoded),
                _ => split.unreleased.insert(encoded),
            };
        }
        split
    }
}

/// Every released version of the browser in browserslist-rs and in BCD.
///
/// browserslist-rs gives the core its lowest target versions, so every target is in its list. The core
/// judges the target and every later released version by the ranges from BCD, and the caniuse data of
/// browserslist-rs 0.21 lacks many of those versions: it ends at Chrome 151 while BCD 8.1.4 has
/// Chrome 154 current, and it jumps from Opera for Android 12.1 to 80. BCD removed support in some
/// missing releases (`Document.browsingTopics` in Chrome 153), and some features have a gap in them
/// (Opera for Android 14 and 15). A reference on the browserslist-rs list alone calls those features
/// supported. Beta, nightly and planned releases are not out, so they are not checked.
fn versions(browser: Browser, releases: &Releases) -> Vec<u32> {
    let name = NAMES.iter().find(|(_, key)| *key == browser.bcd_key()).unwrap().0;
    let query = format!("{name} > 0");
    let mut versions: BTreeSet<u32> = browserslist::resolve([query.as_str()], &browserslist::Opts::default())
        .unwrap()
        .iter()
        .flat_map(|distrib| browserslist_versions(distrib.version()))
        .collect();
    assert!(!versions.is_empty(), "{query}: no versions");
    versions.extend(&releases.released);
    versions.into_iter().collect()
}

fn collect(node: &Value, path: &str, releases: &[Releases], features: &mut Vec<Feature>) {
    let Value::Object(entries) = node else {
        return;
    };
    for (key, value) in entries {
        if key == "__compat" {
            let support = &value["support"];
            features.push(Feature {
                id: path.to_string(),
                statements: Browser::ALL
                    .iter()
                    .map(|browser| statements(&support[browser.bcd_key()], &releases[browser.index()]))
                    .collect(),
            });
        } else {
            collect(value, &format!("{path}.{key}"), releases, features);
        }
    }
}

/// The usable statements of one browser: one object or an array of them.
fn statements(support: &Value, releases: &Releases) -> Vec<Statement> {
    let list = match support {
        Value::Array(list) => list.as_slice(),
        Value::Null => &[],
        single => std::slice::from_ref(single),
    };
    list.iter()
        .filter(|statement| {
            ["flags", "prefix", "alternative_name"]
                .iter()
                .all(|key| statement.get(key).is_none())
        })
        .filter_map(|statement| {
            let added = match &statement["version_added"] {
                Value::Bool(true) => 0,
                Value::String(text) => parse_version(text.trim_start_matches('≤'))?,
                _ => return None,
            };
            let removed = match &statement["version_removed"] {
                Value::String(text) if text != "preview" => {
                    let removed = parse_version(text.trim_start_matches('≤'))
                        .unwrap_or_else(|| panic!("version_removed {text:?}"));
                    // A release that is not out yet removes nothing from the released versions.
                    if releases.unreleased.contains(&removed) {
                        NONE
                    } else {
                        removed
                    }
                }
                // A removal at an unknown version leaves no version with known support.
                Value::Bool(true) => 0,
                _ => NONE,
            };
            Some(Statement {
                added,
                removed,
                partial: statement["partial_implementation"] == Value::Bool(true),
                note: note(&statement["notes"]),
            })
        })
        .collect()
}

/// The first note as plain text: without tags and entities, with single spaces.
fn note(notes: &Value) -> Option<String> {
    let first = match notes {
        Value::Array(list) => list.first()?,
        other => other,
    };
    let raw = first.as_str()?;
    let mut text = String::new();
    let mut tag = false;
    for character in raw.chars() {
        match character {
            '<' => tag = true,
            '>' if tag => tag = false,
            _ if !tag => text.push(character),
            _ => {}
        }
    }
    let mut decoded = String::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        rest = &rest[start..];
        let entity = rest.find(';').map(|end| (&rest[1..end], end));
        let character = entity.and_then(|(name, _)| match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "nbsp" => Some(' '),
            _ => {
                let code = match name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => name.strip_prefix('#')?.parse().ok(),
                };
                char::from_u32(code?)
            }
        });
        match (character, entity) {
            (Some(character), Some((_, end))) => {
                decoded.push(character);
                rest = &rest[end + 1..];
            }
            _ => {
                decoded.push('&');
                rest = &rest[1..];
            }
        }
    }
    decoded.push_str(rest);
    Some(decoded.split_whitespace().collect::<Vec<_>>().join(" "))
}
