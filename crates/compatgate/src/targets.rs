//! Turns the browsers of a browserslist query into the lowest supported version of each browser, and
//! the support of every feature under those versions.

use crate::Error;
use crate::data::{Browser, FeatureId, encode_version};
use crate::detect::methods::{Decision, MethodTable};
use crate::support::{SupportTable, TargetSupport};

/// browserslist names that BCD has no data for by design, so they give no warning: Opera Mini, UC Browser
/// and QQ Browser for Android, KaiOS. The README of the core lists them.
const NO_DATA_BY_DEFINITION: [&str; 4] = ["and_qq", "and_uc", "kaios", "op_mini"];

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
    /// Takes the browsers in the form that the `browserslist` npm package returns: `chrome 120`,
    /// `safari 15.6-15.8`. Resolve the query in JavaScript: there the package finds the config, expands
    /// `extends` relative to the checked file and has the newest data.
    pub fn from_browserslist(browsers: &[&str]) -> Result<Self, Error> {
        if browsers.is_empty() {
            return Err(Error::Targets("the list of browsers is empty".to_string()));
        }
        Self::build(browsers, || browsers.join(", "))
    }

    /// `name` gives the selection in the error of a selection without data.
    fn build(browsers: &[&str], name: impl FnOnce() -> String) -> Result<Self, Error> {
        let mut minimum: Vec<(Browser, u32)> = Vec::new();
        let mut ignored: Vec<String> = Vec::new();
        for entry in browsers {
            let invalid = || Error::Targets(format!("\"{entry}\" is not a browser and version of browserslist"));
            let Some((name, version)) = entry.split_once(' ').filter(|(name, _)| !name.is_empty()) else {
                return Err(invalid());
            };
            let Some(browser) = Browser::from_browserslist(name) else {
                if !NO_DATA_BY_DEFINITION.contains(&name) && !ignored.iter().any(|known| known == name) {
                    ignored.push(name.to_string());
                }
                continue;
            };
            // Safari Technology Preview ("TP") is newer than any release, so it never lowers the minimum.
            if version == "TP" {
                continue;
            }
            // Another version that does not parse is a bug of the caller: skipped, it would drop the browser.
            let version = encode_version(version).ok_or_else(invalid)?;
            match minimum.iter_mut().find(|(known, _)| *known == browser) {
                Some((_, lowest)) => *lowest = (*lowest).min(version),
                None => minimum.push((browser, version)),
            }
        }
        if minimum.is_empty() {
            return Err(Error::Targets(format!(
                "{}: selects no browser with compatibility data",
                name()
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

    /// Resolves the query with the browserslist-rs crate, for a caller without Node. Its data is older
    /// than the data of the npm package, and it resolves `extends` by running `node` in the current
    /// directory of the process.
    #[cfg(feature = "browserslist")]
    pub fn resolve(query: &str) -> Result<Self, Error> {
        let distribs = browserslist::resolve([query], &browserslist::Opts::default())
            .map_err(|error| Error::Targets(format!("{query}: {error}")))?;
        let browsers: Vec<String> = distribs
            .iter()
            .map(|distrib| format!("{} {}", distrib.name(), distrib.version()))
            .collect();
        let browsers: Vec<&str> = browsers.iter().map(String::as_str).collect();
        Self::build(&browsers, || query.to_string())
    }

    /// Targets under which every feature is missing in every browser, for detector tests.
    #[cfg(test)]
    pub(crate) fn missing_everything() -> Self {
        Self::missing_except(&[])
    }

    /// Targets under which every feature but `supported` is missing in every browser, for detector tests.
    #[cfg(test)]
    pub(crate) fn missing_except(supported: &[FeatureId]) -> Self {
        let table = SupportTable::missing_except(supported);
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

    /// Whether every target version without full support of `usage` lacks `check` entirely, partial
    /// support included. Then code that runs only where `check` is present finds `usage` fully supported.
    /// The masks of the table are not enough: a browser can lack `check` only in its lowest target version
    /// and `usage` in many more.
    pub(crate) fn implies(&self, check: FeatureId, usage: FeatureId) -> bool {
        let first = || self.first_supports(check);
        self.implies_by(check, usage, first)
    }

    /// `implies` with `first_supports(check)` from the caller, which can keep it: each version costs
    /// a binary search in the data, and a file can ask about one check thousands of times. The masks
    /// are the quick check, so `first` runs only when they pass.
    pub(crate) fn implies_by<F: AsRef<[u32]>>(
        &self,
        check: FeatureId,
        usage: FeatureId,
        first: impl FnOnce() -> F,
    ) -> bool {
        let gaps = self.support(usage).gaps();
        // A browser without full support of `usage` must lack `check`.
        if gaps.is_empty() || !gaps.is_subset(self.support(check).missing) {
            return false;
        }
        let first = first();
        self.minimum
            .iter()
            .zip(first.as_ref())
            .all(|(&(browser, _), &first)| !gaps.contains(browser) || first >= usage.full_support(browser))
    }

    /// The first version with any support of `check` from the target on, for each target browser in
    /// the order of `minimum`.
    pub(crate) fn first_supports(&self, check: FeatureId) -> Box<[u32]> {
        self.minimum
            .iter()
            .map(|&(browser, target)| check.first_support(browser, target))
            .collect()
    }

    /// The finding for a call `.name()` on an object of unknown type, if the name has one.
    pub(crate) fn method(&self, name: &str) -> Option<Decision> {
        self.methods.get(name)
    }
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
    fn takes_the_lowest_version_of_each_browser_from_a_list() {
        let targets = Targets::from_browserslist(&[
            "chrome 120",
            "chrome 97",
            "firefox 115",
            "safari TP",
            "safari 15.6-15.8",
            "ios_saf 18.5-18.7",
            "ios_saf 15.5",
        ])
        .unwrap();
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
    fn reports_browsers_without_bcd_data_unless_bcd_lacks_them_by_definition() {
        let targets = Targets::from_browserslist(&[
            "chrome 97",
            "op_mini all",
            "and_uc 15.5",
            "and_qq 14.9",
            "kaios 3.0-3.1",
            "ie 11",
            "ie 10",
            "baidu 13.52",
        ])
        .unwrap();
        assert_eq!(targets.minimum(), &[(Browser::Chrome, version("97"))]);
        assert_eq!(targets.ignored(), &["baidu".to_string(), "ie".to_string()]);
    }

    #[test]
    fn rejects_a_list_without_browsers_with_data_and_names_it() {
        let error = Targets::from_browserslist(&["op_mini all", "ie 11"]).unwrap_err();
        assert_eq!(
            error,
            Error::Targets("op_mini all, ie 11: selects no browser with compatibility data".to_string())
        );
    }

    #[test]
    fn rejects_an_empty_list() {
        let error = Targets::from_browserslist(&[]).unwrap_err();
        assert_eq!(error, Error::Targets("the list of browsers is empty".to_string()));
    }

    #[test]
    fn rejects_an_entry_that_is_no_browser_and_version() {
        for entry in [
            "chrome",
            "chrome ",
            "chrome foo",
            "chrome 97 x",
            "firefox all",
            " chrome 97",
            "safari tp",
        ] {
            let error = Targets::from_browserslist(&["chrome 97", entry]).unwrap_err();
            assert_eq!(
                error,
                Error::Targets(format!("\"{entry}\" is not a browser and version of browserslist")),
                "{entry}"
            );
        }
    }

    #[test]
    fn resolves_a_query_with_the_browserslist_feature() {
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
        let targets = Targets::resolve("Chrome >= 97, op_mini all, ie 11").unwrap();
        assert_eq!(targets.ignored(), &["ie".to_string()]);
    }

    #[test]
    fn rejects_an_invalid_query_and_names_it() {
        let error = Targets::resolve("Chrom >= 97").unwrap_err();
        assert!(
            matches!(&error, Error::Targets(text) if text.contains("Chrom >= 97")),
            "{error}"
        );
        let error = Targets::resolve("op_mini all").unwrap_err();
        assert!(
            matches!(&error, Error::Targets(text) if text.starts_with("op_mini all: ")),
            "{error}"
        );
    }
}
