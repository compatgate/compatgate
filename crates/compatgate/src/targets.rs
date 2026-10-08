//! Resolves a browserslist query into the lowest supported version of each browser, and the support
//! of every feature under those versions.

use crate::Error;
use crate::data::{Browser, FeatureId, encode_version};
use crate::detect::methods::{Decision, MethodTable};
use crate::support::{SupportTable, TargetSupport};

/// Resolved targets with the support of every feature under them. Resolve them once per query:
/// the table costs a data lookup per feature and target browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Targets {
    minimum: Vec<(Browser, u32)>,
    ignored: Vec<String>,
    table: SupportTable,
    methods: MethodTable,
}

impl Targets {
    pub fn resolve(query: &str) -> Result<Self, Error> {
        if has_extends(query) {
            // browserslist-rs resolves `extends` by running `node` in the current directory of the process.
            // That finds the wrong package or none, and on wasm32 it returns nothing without an error.
            // The JavaScript layer expands `extends` relative to the checked file instead.
            return Err(Error::Targets(format!(
                "{query}: \"extends\" must be expanded before the query reaches the core"
            )));
        }
        let distribs = browserslist::resolve([query], &browserslist::Opts::default())
            .map_err(|error| Error::Targets(format!("{query}: {error}")))?;
        let mut minimum: Vec<(Browser, u32)> = Vec::new();
        let mut ignored: Vec<String> = Vec::new();
        for distrib in &distribs {
            let Some(browser) = Browser::from_browserslist(distrib.name()) else {
                if !ignored.iter().any(|name| name == distrib.name()) {
                    ignored.push(distrib.name().to_string());
                }
                continue;
            };
            // Safari Technology Preview ("TP") is newer than any release, so it never lowers the minimum.
            let Some(version) = encode_version(distrib.version()) else {
                continue;
            };
            match minimum.iter_mut().find(|(known, _)| *known == browser) {
                Some((_, lowest)) => *lowest = (*lowest).min(version),
                None => minimum.push((browser, version)),
            }
        }
        if minimum.is_empty() {
            return Err(Error::Targets(format!(
                "{query}: selects no browser with compatibility data"
            )));
        }
        minimum.sort();
        ignored.sort();
        let table = SupportTable::new(&minimum);
        let methods = MethodTable::new(&table);
        Ok(Self {
            minimum,
            ignored,
            table,
            methods,
        })
    }

    /// Targets under which every feature is missing in every browser, for detector tests.
    #[cfg(test)]
    pub(crate) fn missing_everything() -> Self {
        let table = SupportTable::missing_everything();
        let methods = MethodTable::new(&table);
        Self {
            minimum: Browser::ALL.iter().map(|&browser| (browser, 0)).collect(),
            ignored: Vec::new(),
            table,
            methods,
        }
    }

    pub fn minimum(&self) -> &[(Browser, u32)] {
        &self.minimum
    }

    /// Browsers of the query that have no compatibility data, for example `op_mini`.
    pub fn ignored(&self) -> &[String] {
        &self.ignored
    }

    /// The absence mask and the partial mask of the feature.
    pub fn support(&self, feature: FeatureId) -> TargetSupport {
        self.table.get(feature)
    }

    /// Every target browser supports the feature fully, so a use of it is no finding.
    pub fn is_supported(&self, feature: FeatureId) -> bool {
        self.table.get(feature).is_supported()
    }

    /// The finding for a call `.name()` on an object of unknown type, if the name has one.
    pub(crate) fn method(&self, name: &str) -> Option<Decision<'_>> {
        self.methods.get(name)
    }
}

fn has_extends(query: &str) -> bool {
    let query = query.to_ascii_lowercase();
    query
        .split(',')
        .flat_map(|part| part.split(" or "))
        .flat_map(|part| part.split(" and "))
        .map(str::trim)
        .any(|term| term == "extends" || term.starts_with("extends "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::encode_version;

    const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

    fn version(text: &str) -> u32 {
        encode_version(text).unwrap()
    }

    #[test]
    fn resolves_lowest_version_per_browser() {
        let targets = Targets::resolve(QUERY).unwrap();
        assert_eq!(
            targets.minimum(),
            &[
                (Browser::Chrome, version("97")),
                (Browser::Firefox, version("115")),
                (Browser::Safari, version("15.6")),
                (Browser::SafariIos, version("15.5")),
            ]
        );
        assert!(targets.ignored().is_empty());
    }

    #[test]
    fn reports_browsers_without_bcd_data() {
        let targets = Targets::resolve("Chrome >= 97, op_mini all").unwrap();
        assert_eq!(targets.minimum(), &[(Browser::Chrome, version("97"))]);
        assert_eq!(targets.ignored(), &["op_mini".to_string()]);
    }

    #[test]
    fn rejects_an_invalid_query_and_names_it() {
        let error = Targets::resolve("Chrom >= 97").unwrap_err();
        assert!(
            matches!(&error, Error::Targets(text) if text.contains("Chrom >= 97")),
            "{error}"
        );
    }

    #[test]
    fn rejects_extends_because_the_caller_must_expand_it() {
        for query in [
            "extends browserslist-config-foo",
            "Chrome >= 97, extends foo",
            "Chrome >= 97 or Extends foo",
        ] {
            let error = Targets::resolve(query).unwrap_err();
            assert!(
                matches!(&error, Error::Targets(text) if text.contains("extends")),
                "{query}: {error}"
            );
        }
    }
}
