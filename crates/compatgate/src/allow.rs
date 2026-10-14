//! Matches findings against the `allow` entries of compatgate.jsonc.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

use crate::Error;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AllowEntry {
    pub feature: String,
    /// Package names. Empty means any file.
    pub packages: Vec<String>,
    /// Glob patterns relative to `base_dir`. Empty means any file.
    pub files: Vec<String>,
    /// Directory of the compatgate.jsonc file that holds the entry.
    pub base_dir: String,
}

#[derive(Debug)]
pub struct AllowList {
    entries: Vec<CompiledEntry>,
}

#[derive(Debug)]
struct CompiledEntry {
    feature: String,
    packages: Vec<String>,
    files: Option<GlobSet>,
}

impl AllowList {
    pub fn new(entries: &[AllowEntry]) -> Result<Self, Error> {
        let entries = entries.iter().map(compile).collect::<Result<Vec<_>, _>>()?;
        Ok(Self { entries })
    }

    pub fn empty() -> Self {
        Self { entries: Vec::new() }
    }

    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// The index of the first entry that allows the feature in the file.
    #[cfg(test)]
    fn find(&self, feature: &str, filename: &str) -> Option<usize> {
        self.matcher(filename).find(feature)
    }

    /// Matches the entries against one file: the path is normalized and its package found once for all
    /// features of the file.
    pub(crate) fn matcher(&self, filename: &str) -> Matcher<'_> {
        let path = normalize(filename);
        let package = package_name(&path).map(str::to_owned);
        Matcher {
            entries: &self.entries,
            path,
            package,
        }
    }
}

/// The entries of an `AllowList` for one file: see `AllowList::matcher`.
#[derive(Debug)]
pub(crate) struct Matcher<'a> {
    entries: &'a [CompiledEntry],
    path: String,
    package: Option<String>,
}

impl Matcher<'_> {
    /// The index of the first entry that allows the feature in the file.
    pub(crate) fn find(&self, feature: &str) -> Option<usize> {
        let package = self.package.as_deref();
        self.entries.iter().position(|entry| {
            entry.feature == feature
                && (entry.packages.is_empty()
                    || package.is_some_and(|name| entry.packages.iter().any(|known| known == name)))
                && entry.files.as_ref().is_none_or(|files| files.is_match(&self.path))
        })
    }
}

fn compile(entry: &AllowEntry) -> Result<CompiledEntry, Error> {
    let files = if entry.files.is_empty() {
        None
    } else {
        if entry.base_dir.is_empty() {
            return Err(Error::Allow(format!(
                "{}: \"files\" needs the directory of the config that holds the entry",
                entry.feature
            )));
        }
        // A directory name such as `[work]` must match itself, not act as a glob class.
        let base = globset::escape(normalize(&entry.base_dir).trim_end_matches('/'));
        let mut builder = GlobSetBuilder::new();
        for pattern in &entry.files {
            let pattern = normalize(pattern);
            let absolute = pattern.starts_with('/') || pattern.as_bytes().get(1) == Some(&b':');
            let full = if absolute {
                pattern
            } else {
                collapse_dot_segments(&format!("{base}/{pattern}"))
            };
            let glob = GlobBuilder::new(&full)
                .literal_separator(true)
                .build()
                .map_err(|error| Error::Allow(format!("{}: {error}", entry.feature)))?;
            builder.add(glob);
        }
        Some(
            builder
                .build()
                .map_err(|error| Error::Allow(format!("{}: {error}", entry.feature)))?,
        )
    };
    Ok(CompiledEntry {
        feature: entry.feature.clone(),
        packages: entry.packages.clone(),
        files,
    })
}

/// globset matches `.` and `..` literally, while the checked filenames are absolute paths without them.
/// Without this step `./src/**` would never match and no error would say why.
fn collapse_dot_segments(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "." => {}
            ".." if segments.last().is_some_and(|last| !last.is_empty() && *last != "..") => {
                segments.pop();
            }
            _ => segments.push(segment),
        }
    }
    segments.join("/")
}

fn normalize(path: &str) -> String {
    let mut path = path.replace('\\', "/");
    // Windows drive letters are case-insensitive, and tools pass both `c:` and `C:`.
    if path.as_bytes().get(1) == Some(&b':') && path.as_bytes()[0].is_ascii_alphabetic() {
        path[..1].make_ascii_uppercase();
    }
    path
}

/// The npm package that owns `path`. Uses the last `node_modules` segment,
/// so nested and pnpm layouts resolve to the package that holds the file.
pub(crate) fn package_name(path: &str) -> Option<&str> {
    let start = path.rfind("node_modules/")? + "node_modules/".len();
    let rest = &path[start..];
    let mut segments = rest.splitn(3, '/');
    let first = segments.next().filter(|segment| !segment.is_empty())?;
    if first.starts_with('@') {
        let second = segments.next().filter(|segment| !segment.is_empty())?;
        Some(&rest[..first.len() + 1 + second.len()])
    } else {
        Some(first)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AllowIssue {
    /// The id is not a BCD feature. Usually a typo.
    /// `suggestion` is the closest known id, if there is one: the id with `_static`, or a sibling a few
    /// edits from the last segment. A mistyped parent segment is corrected the same way.
    UnknownFeature {
        index: usize,
        suggestion: Option<&'static str>,
    },
    /// Every target supports the feature, so the entry is no longer needed.
    NativeInTargets { index: usize },
}

/// Checks the entries without any source code.
pub fn validate_allow(entries: &[AllowEntry], targets: &crate::targets::Targets) -> Vec<AllowIssue> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| match crate::data::FeatureId::find(&entry.feature) {
            None => Some(AllowIssue::UnknownFeature {
                index,
                suggestion: suggestion(&entry.feature),
            }),
            Some(feature) => matches!(
                crate::support::evaluate(feature, targets),
                crate::support::Verdict::Supported
            )
            .then_some(AllowIssue::NativeInTargets { index }),
        })
        .collect()
}

/// The most edits between a typed segment and a known one that still gives a suggestion.
const MAX_EDITS: usize = 2;

/// The edits that a typed segment allows: one below six characters, two from six on, as in rustc. Two edits
/// change most of a short segment, and a wrong suggestion is worse than none: `Math.foo` is not `Math.cos`.
fn max_edits(typed: &str) -> usize {
    (typed.chars().count().max(3) / 3).min(MAX_EDITS)
}

/// The closest known id to an unknown `id`: the id with `_static`, as BCD names static members, or the sibling
/// with the fewest edits in the last segment. A parent that is not in the data is corrected the same way, segment
/// by segment. Only the entries with an issue need it, so it scans the sorted ids instead of keeping an index.
fn suggestion(id: &str) -> Option<&'static str> {
    let (parent, last) = id.rsplit_once('.').filter(|(_, last)| !last.is_empty())?;
    let prefix = format!("{}.", node(parent)?);
    for candidate in [format!("{prefix}{last}"), format!("{prefix}{last}_static")] {
        if let Some(feature) = crate::data::FeatureId::find(&candidate) {
            return Some(feature.as_str());
        }
    }
    let siblings = crate::data::ids_with_prefix(&prefix).filter(|sibling| !sibling[prefix.len()..].contains('.'));
    closest(last, siblings)
}

/// `path` or its correction, as a prefix of a known id: `api.URL` for `api.URl`.
fn node(path: &str) -> Option<&'static str> {
    if let Some(feature) = crate::data::FeatureId::find(path) {
        return Some(feature.as_str());
    }
    if let Some(id) = crate::data::ids_with_prefix(&format!("{path}.")).next() {
        return Some(&id[..path.len()]);
    }
    let (prefix, last) = match path.rsplit_once('.') {
        Some((parent, last)) => (format!("{}.", node(parent)?), last),
        None => (String::new(), path),
    };
    // The ids of one child are mostly adjacent, so skipping a repeat saves most of the distances.
    let mut previous = "";
    let children = crate::data::ids_with_prefix(&prefix)
        .map(|id| {
            let rest = &id[prefix.len()..];
            &id[..prefix.len() + rest.find('.').unwrap_or(rest.len())]
        })
        .filter(move |child| std::mem::replace(&mut previous, child) != *child);
    closest(last, children)
}

/// The candidate whose last segment is the fewest edits from `typed`, at most `max_edits(typed)`. Of equal
/// candidates the first in byte order wins, so the suggestion does not depend on the order of the data.
fn closest<'a>(typed: &str, candidates: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let typed_length = typed.chars().count();
    let limit = max_edits(typed);
    candidates
        .filter_map(|candidate| {
            let segment = candidate.rsplit('.').next().unwrap_or(candidate);
            if segment.chars().count().abs_diff(typed_length) > limit {
                return None;
            }
            let edits = edit_distance(typed, segment);
            (edits <= limit).then_some((edits, candidate))
        })
        .min()
        .map(|(_, candidate)| candidate)
}

/// The optimal string alignment (OSA) distance, a restricted Damerau-Levenshtein distance: insertions,
/// deletions, substitutions and swaps of adjacent characters, with no edit of a swapped pair. A swap is one
/// edit, as in rustc and clap, so `fecth` is one edit from `fetch`; plain Levenshtein counts two.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut rows = vec![vec![0; b.len() + 1]; a.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut edits = (rows[i - 1][j] + 1)
                .min(rows[i][j - 1] + 1)
                .min(rows[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                edits = edits.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = edits;
        }
    }
    rows[a.len()][b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(feature: &str) -> AllowEntry {
        AllowEntry {
            feature: feature.to_string(),
            base_dir: "/p".to_string(),
            ..AllowEntry::default()
        }
    }

    #[test]
    fn plain_entry_allows_the_feature_everywhere() {
        let list = AllowList::new(&[entry("api.structuredClone")]).unwrap();
        assert_eq!(list.find("api.structuredClone", "/p/src/a.ts"), Some(0));
        assert_eq!(list.find("api.structuredClone", "/p/node_modules/x/a.js"), Some(0));
        assert_eq!(list.find("api.ResizeObserver", "/p/src/a.ts"), None);
    }

    #[test]
    fn packages_limit_the_entry_to_those_packages() {
        let list = AllowList::new(&[AllowEntry {
            packages: vec!["some-lib".into(), "@scope/pkg".into()],
            ..entry("api.A")
        }])
        .unwrap();
        assert_eq!(list.find("api.A", "/p/node_modules/some-lib/dist/a.js"), Some(0));
        assert_eq!(
            list.find("api.A", "/p/node_modules/x/node_modules/some-lib/a.js"),
            Some(0)
        );
        assert_eq!(list.find("api.A", "/p/node_modules/@scope/pkg/a.js"), Some(0));
        assert_eq!(list.find("api.A", "/p/node_modules/some-lib-extra/a.js"), None);
        assert_eq!(list.find("api.A", "/p/src/a.js"), None);
    }

    #[test]
    fn files_limit_the_entry_to_matching_paths_under_base_dir() {
        let list = AllowList::new(&[AllowEntry {
            files: vec!["src/desktop/**".into()],
            ..entry("api.A")
        }])
        .unwrap();
        assert_eq!(list.find("api.A", "/p/src/desktop/widget/a.ts"), Some(0));
        assert_eq!(list.find("api.A", "/p/src/mobile/a.ts"), None);
        assert_eq!(list.find("api.A", "/other/src/desktop/a.ts"), None);
    }

    #[test]
    fn packages_and_files_together_require_both() {
        let list = AllowList::new(&[AllowEntry {
            packages: vec!["some-lib".into()],
            files: vec!["node_modules/some-lib/esm/**".into()],
            ..entry("api.A")
        }])
        .unwrap();
        assert_eq!(list.find("api.A", "/p/node_modules/some-lib/esm/a.js"), Some(0));
        assert_eq!(list.find("api.A", "/p/node_modules/some-lib/cjs/a.js"), None);
    }

    #[test]
    fn windows_paths_match_like_posix_paths() {
        let list = AllowList::new(&[
            AllowEntry {
                files: vec!["src\\desktop\\**".into()],
                base_dir: "C:\\p".into(),
                ..entry("api.A")
            },
            AllowEntry {
                packages: vec!["some-lib".into()],
                ..entry("api.B")
            },
        ])
        .unwrap();
        assert_eq!(list.find("api.A", "C:\\p\\src\\desktop\\a.ts"), Some(0));
        assert_eq!(list.find("api.B", "C:\\p\\node_modules\\some-lib\\a.js"), Some(1));
    }

    #[test]
    fn returns_the_first_matching_entry() {
        let list = AllowList::new(&[entry("api.B"), entry("api.A"), entry("api.A")]).unwrap();
        assert_eq!(list.find("api.A", "/p/a.js"), Some(1));
    }

    #[test]
    fn invalid_glob_is_an_error() {
        let error = AllowList::new(&[AllowEntry {
            files: vec!["src/[".into()],
            ..entry("api.A")
        }])
        .unwrap_err();
        assert!(matches!(error, Error::Allow(_)), "{error}");
    }

    #[test]
    fn package_name_takes_the_last_node_modules_segment() {
        assert_eq!(package_name("/p/node_modules/a/node_modules/b/x.js"), Some("b"));
        assert_eq!(package_name("/p/node_modules/@s/b/x.js"), Some("@s/b"));
        assert_eq!(
            package_name("/p/node_modules/.pnpm/b@1.0.0/node_modules/b/x.js"),
            Some("b")
        );
        assert_eq!(package_name("/p/src/x.js"), None);
        assert_eq!(package_name("/p/node_modules/"), None);
    }

    #[test]
    fn validation_reports_unknown_and_native_features() {
        let targets =
            crate::targets::Targets::resolve("Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115").unwrap();
        let issues = validate_allow(
            &[
                entry("api.structuredClone"),
                entry("api.DoesNotExist"),
                entry("javascript.builtins.Array.at"),
            ],
            &targets,
        );
        assert_eq!(
            issues,
            [
                AllowIssue::UnknownFeature {
                    index: 1,
                    suggestion: None
                },
                AllowIssue::NativeInTargets { index: 2 }
            ]
        );
    }

    #[test]
    fn an_unknown_feature_suggests_the_closest_known_id() {
        let targets = crate::targets::Targets::resolve("Chrome >= 97").unwrap();
        let issues = validate_allow(&[entry("api.URL.canParse"), entry("api.fetchh")], &targets);
        assert_eq!(
            issues,
            [
                AllowIssue::UnknownFeature {
                    index: 0,
                    suggestion: Some("api.URL.canParse_static")
                },
                AllowIssue::UnknownFeature {
                    index: 1,
                    suggestion: Some("api.fetch")
                },
            ]
        );
    }

    #[test]
    fn the_suggestion_is_a_sibling_within_two_edits() {
        // A transposition is one edit.
        assert_eq!(suggestion("api.fecth"), Some("api.fetch"));
        assert_eq!(suggestion("api.Fetch"), Some("api.fetch"));
        assert_eq!(
            suggestion("javascript.builtins.Array.att"),
            Some("javascript.builtins.Array.at")
        );
        assert_eq!(suggestion("api.DoesNotExist"), None);
        assert_eq!(suggestion("api.fetchhhh"), None);
        assert_eq!(suggestion("nothing"), None);
        assert_eq!(suggestion(""), None);
    }

    #[test]
    fn a_short_segment_allows_fewer_edits() {
        // Two edits change most of a short segment, so the limit grows with its length.
        for id in [
            "javascript.builtins.Math.foo",
            "javascript.builtins.Array.bar",
            "javascript.builtins.Array.to",
            "javascript.builtins.Array.xy",
            "javascript.builtins.Array.",
            "javascript.operators.xx",
            "api.a",
            "api.ab",
            "api.",
            "a.b",
            "api.Foo",
        ] {
            assert_eq!(suggestion(id), None, "{id}");
        }
        assert_eq!(max_edits(""), 1);
        assert_eq!(max_edits("abcde"), 1);
        assert_eq!(max_edits("abcdef"), 2);
        assert_eq!(max_edits("abcdefghijkl"), 2);
    }

    #[test]
    fn a_mistyped_parent_is_corrected_too() {
        assert_eq!(suggestion("api.URl.canParse"), Some("api.URL.canParse_static"));
        assert_eq!(suggestion("apii.fetch"), Some("api.fetch"));
        assert_eq!(suggestion("api.Nothing.at.all"), None);
    }

    #[test]
    fn equal_distances_take_the_first_id_in_order() {
        let candidates = ["b", "a", "c"];
        assert_eq!(closest("x", candidates.into_iter()), Some("a"));
    }

    #[test]
    fn edit_distance_counts_adjacent_transpositions_as_one() {
        assert_eq!(edit_distance("fetch", "fecth"), 1);
        assert_eq!(edit_distance("fetch", "fetch"), 0);
        assert_eq!(edit_distance("", "ab"), 2);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        assert_eq!(edit_distance("ca", "abc"), 3);
    }

    #[test]
    fn files_patterns_with_dot_segments_resolve_against_base_dir() {
        let list = AllowList::new(&[
            AllowEntry {
                files: vec!["./src/**".into()],
                ..entry("api.A")
            },
            AllowEntry {
                files: vec!["../shared/**".into()],
                base_dir: "/p/app".into(),
                ..entry("api.B")
            },
        ])
        .unwrap();
        assert_eq!(list.find("api.A", "/p/src/a.js"), Some(0));
        assert_eq!(list.find("api.B", "/p/shared/a.js"), Some(1));
        assert_eq!(list.find("api.B", "/p/app/shared/a.js"), None);
    }

    #[test]
    fn base_dir_with_glob_characters_is_literal() {
        let list = AllowList::new(&[
            AllowEntry {
                files: vec!["src/**".into()],
                base_dir: "/p/[work]".into(),
                ..entry("api.A")
            },
            AllowEntry {
                files: vec!["src/**".into()],
                base_dir: "/p/{x".into(),
                ..entry("api.B")
            },
        ])
        .unwrap();
        assert_eq!(list.find("api.A", "/p/[work]/src/a.js"), Some(0));
        assert_eq!(list.find("api.A", "/p/w/src/a.js"), None);
        assert_eq!(list.find("api.B", "/p/{x/src/a.js"), Some(1));
    }

    #[test]
    fn files_without_base_dir_is_an_error() {
        let error = AllowList::new(&[AllowEntry {
            files: vec!["src/**".into()],
            base_dir: String::new(),
            ..entry("api.A")
        }])
        .unwrap_err();
        assert!(matches!(error, Error::Allow(_)), "{error}");
    }

    #[test]
    fn windows_drive_letter_case_does_not_matter() {
        let upper = AllowList::new(&[AllowEntry {
            files: vec!["src/**".into()],
            base_dir: "C:\\p".into(),
            ..entry("api.A")
        }])
        .unwrap();
        assert_eq!(upper.find("api.A", "c:\\p\\src\\a.ts"), Some(0));
        let lower = AllowList::new(&[AllowEntry {
            files: vec!["src/**".into()],
            base_dir: "c:/p".into(),
            ..entry("api.A")
        }])
        .unwrap();
        assert_eq!(lower.find("api.A", "C:/p/src/a.ts"), Some(0));
    }
}
