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

    pub fn find(&self, feature: &str, filename: &str) -> Option<usize> {
        let path = normalize(filename);
        let package = package_name(&path);
        self.entries.iter().position(|entry| {
            entry.feature == feature
                && (entry.packages.is_empty()
                    || package.is_some_and(|name| entry.packages.iter().any(|known| known == name)))
                && entry.files.as_ref().is_none_or(|files| files.is_match(&path))
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
pub fn package_name(path: &str) -> Option<&str> {
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
    UnknownFeature { index: usize },
    /// Every target supports the feature, so the entry is no longer needed.
    NativeInTargets { index: usize },
}

/// Checks the entries without any source code.
pub fn validate_allow(entries: &[AllowEntry], targets: &crate::targets::Targets) -> Vec<AllowIssue> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| match crate::data::FeatureId::find(&entry.feature) {
            None => Some(AllowIssue::UnknownFeature { index }),
            Some(feature) => matches!(
                crate::support::evaluate(feature, targets),
                crate::support::Verdict::Supported
            )
            .then_some(AllowIssue::NativeInTargets { index }),
        })
        .collect()
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
                AllowIssue::UnknownFeature { index: 1 },
                AllowIssue::NativeInTargets { index: 2 }
            ]
        );
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
