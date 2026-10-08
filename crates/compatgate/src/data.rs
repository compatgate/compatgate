//! Browser support data compiled from @mdn/browser-compat-data.

// The generator writes this file. Formatting it would make it differ from the generator output,
// and lints about long numeric literals would report every row of the tables.
#[rustfmt::skip]
#[allow(clippy::all)]
mod generated;

pub use generated::BCD_VERSION;
use generated::{FEATURES, INSTANCE_MEMBERS, INTERFACE_PARENTS, NOTES, RANGES, SINGLETONS};

/// A row of `RANGES`: feature index, browser column, the range `[first version, version of removal)`,
/// whether the support is partial, index into `NOTES` or `UNSUPPORTED`. A range without a removal
/// ends at `UNSUPPORTED`. The rows of a browser start before the version from which full support lasts.
type RangeRow = (u32, u8, u32, u32, bool, u32);

/// Version value for "not supported". It is larger than any real version.
pub const UNSUPPORTED: u32 = u32::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Browser {
    Chrome,
    ChromeAndroid,
    Edge,
    Firefox,
    FirefoxAndroid,
    Opera,
    OperaAndroid,
    Safari,
    SafariIos,
    SamsungInternetAndroid,
    WebviewAndroid,
}

impl Browser {
    /// Same order as `BROWSERS` in scripts/generate-data.js.
    pub const ALL: [Browser; 11] = [
        Browser::Chrome,
        Browser::ChromeAndroid,
        Browser::Edge,
        Browser::Firefox,
        Browser::FirefoxAndroid,
        Browser::Opera,
        Browser::OperaAndroid,
        Browser::Safari,
        Browser::SafariIos,
        Browser::SamsungInternetAndroid,
        Browser::WebviewAndroid,
    ];

    pub fn index(self) -> usize {
        self as usize
    }

    pub fn bcd_key(self) -> &'static str {
        match self {
            Browser::Chrome => "chrome",
            Browser::ChromeAndroid => "chrome_android",
            Browser::Edge => "edge",
            Browser::Firefox => "firefox",
            Browser::FirefoxAndroid => "firefox_android",
            Browser::Opera => "opera",
            Browser::OperaAndroid => "opera_android",
            Browser::Safari => "safari",
            Browser::SafariIos => "safari_ios",
            Browser::SamsungInternetAndroid => "samsunginternet_android",
            Browser::WebviewAndroid => "webview_android",
        }
    }

    pub fn from_browserslist(name: &str) -> Option<Self> {
        Some(match name {
            "chrome" => Browser::Chrome,
            "and_chr" => Browser::ChromeAndroid,
            "edge" => Browser::Edge,
            "firefox" => Browser::Firefox,
            "and_ff" => Browser::FirefoxAndroid,
            "opera" => Browser::Opera,
            "op_mob" => Browser::OperaAndroid,
            "safari" => Browser::Safari,
            "ios_saf" => Browser::SafariIos,
            "samsung" => Browser::SamsungInternetAndroid,
            "android" => Browser::WebviewAndroid,
            _ => return None,
        })
    }
}

/// A BCD feature, stored as an index into the generated tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FeatureId(u32);

impl FeatureId {
    pub fn find(id: &str) -> Option<Self> {
        FEATURES
            .binary_search_by(|(key, _)| (*key).cmp(id))
            .ok()
            .map(|index| Self(index as u32))
    }

    pub fn as_str(self) -> &'static str {
        FEATURES[self.0 as usize].0
    }

    /// First version from which full support lasts to the latest release, or `UNSUPPORTED`.
    pub fn full_support(self, browser: Browser) -> u32 {
        FEATURES[self.0 as usize].1[browser.index()]
    }

    /// Support in `target` and every later version of `browser`.
    pub fn support_from(self, browser: Browser, target: u32) -> Support {
        let rows = browser_rows(RANGES, self.0, browser.index() as u8);
        support_from(self.full_support(browser), rows, target)
    }
}

/// Support of a feature in a version of a browser and every later version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    /// Full support without a gap.
    Full,
    /// Full or partial support without a gap, and partial in some versions. The note is the BCD text
    /// of the partial statement that covers the version, or of the latest partial statement before it.
    Partial(Option<&'static str>),
    /// A gap: some version from the given one on has no support.
    Missing,
}

/// The rows of one feature and browser. The table is sorted by feature, browser and range.
fn browser_rows(table: &[RangeRow], feature: u32, column: u8) -> &[RangeRow] {
    let key = (feature, column);
    let start = table.partition_point(|row| (row.0, row.1) < key);
    let end = start + table[start..].partition_point(|row| (row.0, row.1) == key);
    &table[start..end]
}

/// `since` is the first version of full support that lasts; `rows` are sorted by their first version.
fn support_from(since: u32, rows: &[RangeRow], target: u32) -> Support {
    if since <= target {
        return Support::Full;
    }
    // Versions from `target` up to `covered` have full or partial support.
    let mut covered = target;
    for row in rows {
        if row.2 > covered {
            break;
        }
        covered = covered.max(row.3);
    }
    if covered < since {
        return Support::Missing;
    }
    let started = || rows.iter().rev().filter(|row| row.4 && row.2 <= target);
    let note = started()
        .find(|row| target < row.3)
        .or_else(|| started().next())
        .and_then(|row| (row.5 != UNSUPPORTED).then(|| NOTES[row.5 as usize]));
    Support::Partial(note)
}

pub fn feature_ids() -> impl Iterator<Item = &'static str> {
    FEATURES.iter().map(|(id, _)| *id)
}

/// Instance members with this name, with a flag that tells whether a finding may name the member.
/// Methods of JavaScript builtins can be findings. Other members only make a name ambiguous:
/// Web API members, accessors, and methods of `DisposableStack` and `AsyncDisposableStack`.
pub fn instance_members(name: &str) -> impl Iterator<Item = (FeatureId, bool)> {
    let start = INSTANCE_MEMBERS.partition_point(|&(member, _, _)| member < name);
    INSTANCE_MEMBERS[start..]
        .iter()
        .take_while(move |&&(member, _, _)| member == name)
        .map(|&(_, feature, reportable)| (FeatureId(feature), reportable))
}

/// The Web API interface of a global singleton, for example `Navigator` for `navigator`.
pub fn singleton_interface(name: &str) -> Option<&'static str> {
    SINGLETONS
        .binary_search_by(|&(singleton, _)| singleton.cmp(name))
        .ok()
        .map(|index| SINGLETONS[index].1)
}

/// Direct parents of a Web API interface from its `extends` clauses in @types/web, for example `Node`
/// for `Document`. Parents can be mixins without BCD data, such as `GlobalEventHandlers`.
pub fn interface_parents(name: &str) -> &'static [&'static str] {
    INTERFACE_PARENTS
        .binary_search_by(|&(interface, _)| interface.cmp(name))
        .map_or(&[], |index| INTERFACE_PARENTS[index].1)
}

/// Encodes `major.minor.patch` as `major << 16 | minor << 8 | patch`.
/// A browserslist range such as `18.5-18.7` uses its lower bound.
pub fn encode_version(text: &str) -> Option<u32> {
    let lower = text.split('-').next()?;
    let mut parts = lower.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = match parts.next() {
        Some(part) => part.parse::<u32>().ok()?,
        None => 0,
    };
    let patch = match parts.next() {
        Some(part) => part.parse::<u32>().ok()?,
        None => 0,
    };
    if parts.next().is_some() || major > 0xffff || minor > 0xff || patch > 0xff {
        return None;
    }
    Some(major << 16 | minor << 8 | patch)
}

pub fn format_version(version: u32) -> String {
    let (major, minor, patch) = (version >> 16, (version >> 8) & 0xff, version & 0xff);
    match (minor, patch) {
        (0, 0) => format!("{major}"),
        (_, 0) => format!("{major}.{minor}"),
        _ => format!("{major}.{minor}.{patch}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_order_matches_generated_tables() {
        for browser in Browser::ALL {
            assert_eq!(generated::BROWSER_KEYS[browser.index()], browser.bcd_key());
        }
    }

    #[test]
    fn features_are_sorted_for_binary_search() {
        assert!(generated::FEATURES.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }

    #[test]
    fn finds_feature_and_reads_full_support() {
        let feature = FeatureId::find("api.structuredClone").expect("feature exists");
        assert_eq!(feature.as_str(), "api.structuredClone");
        assert_eq!(feature.full_support(Browser::Chrome), encode_version("98").unwrap());
        assert_eq!(FeatureId::find("api.DoesNotExist"), None);
    }

    #[test]
    fn reads_partial_support() {
        let feature = FeatureId::find("api.BarcodeDetector").expect("feature exists");
        assert!(matches!(
            feature.support_from(Browser::Chrome, encode_version("97").unwrap()),
            Support::Partial(_)
        ));
        assert_eq!(
            feature.support_from(Browser::Firefox, encode_version("1").unwrap()),
            Support::Missing
        );
    }

    #[test]
    fn encodes_and_formats_versions() {
        assert_eq!(encode_version("15.6"), Some(15 << 16 | 6 << 8));
        assert_eq!(encode_version("18.5-18.7"), Some(18 << 16 | 5 << 8));
        assert_eq!(encode_version("TP"), None);
        assert_eq!(encode_version("1.2.3.4"), None);
        assert_eq!(format_version(97 << 16), "97");
        assert_eq!(format_version(15 << 16 | 6 << 8), "15.6");
        assert_eq!(format_version(1 << 16 | 2 << 8 | 3), "1.2.3");
    }

    #[test]
    fn maps_browserslist_names() {
        assert_eq!(Browser::from_browserslist("ios_saf"), Some(Browser::SafariIos));
        assert_eq!(Browser::from_browserslist("and_chr"), Some(Browser::ChromeAndroid));
        assert_eq!(Browser::from_browserslist("op_mini"), None);
    }

    #[test]
    fn reads_the_note_of_partial_support() {
        let feature = FeatureId::find("api.BarcodeDetector").unwrap();
        let note = |version| match feature.support_from(Browser::Chrome, encode_version(version).unwrap()) {
            Support::Partial(note) => note,
            other => panic!("Chrome {version}: {other:?}"),
        };
        assert!(note("97").unwrap().contains("ChromeOS"));
        // BCD: partial support from 83 to 88 with its own note, then partial support from 88.
        assert_eq!(note("87"), Some("Supported on macOS only."));
        assert_eq!(
            feature.support_from(Browser::Chrome, encode_version("82").unwrap()),
            Support::Missing
        );
        assert_eq!(
            feature.support_from(Browser::Firefox, UNSUPPORTED - 1),
            Support::Missing
        );
    }

    const fn row(added: u32, removed: u32, partial: bool, note: u32) -> RangeRow {
        (
            7,
            0,
            added << 16,
            if removed == UNSUPPORTED { removed } else { removed << 16 },
            partial,
            note,
        )
    }

    const U: u32 = UNSUPPORTED;

    #[test]
    fn finds_the_rows_of_a_feature_and_browser() {
        let table: &[RangeRow] = &[
            (3, 0, 1 << 16, U, true, 0),
            row(10, 20, true, 0),
            row(20, U, true, 1),
            (7, 1, 5 << 16, U, true, 2),
            (8, 0, 1 << 16, U, true, 3),
        ];
        assert_eq!(browser_rows(table, 7, 0), &table[1..3]);
        assert_eq!(browser_rows(table, 7, 2), &[]);
        assert_eq!(browser_rows(table, 5, 0), &[]);
    }

    #[test]
    fn full_support_that_lasts_from_the_target_is_full() {
        assert_eq!(support_from(30 << 16, &[], 30 << 16), Support::Full);
        assert_eq!(support_from(30 << 16, &[], 29 << 16), Support::Missing);
        assert_eq!(support_from(U, &[], 29 << 16), Support::Missing);
    }

    #[test]
    fn ranges_without_a_gap_up_to_full_support_are_partial() {
        // Partial 10–20 with note 0, full 20–25, partial 25–30 with note 1, full from 30.
        let rows = [row(10, 20, true, 0), row(20, 25, false, U), row(25, 30, true, 1)];
        let at = |version: u32| support_from(30 << 16, &rows, version << 16);
        assert_eq!(at(9), Support::Missing);
        assert_eq!(at(10), Support::Partial(Some(NOTES[0])));
        // Full support covers 22, so the note is the one of the latest partial range before it.
        assert_eq!(at(22), Support::Partial(Some(NOTES[0])));
        assert_eq!(at(27), Support::Partial(Some(NOTES[1])));
        assert_eq!(at(30), Support::Full);
    }

    #[test]
    fn a_gap_before_full_support_is_missing() {
        let rows = [row(10, 20, true, 0), row(21, U, true, 1)];
        assert_eq!(support_from(U, &rows, 15 << 16), Support::Missing);
        assert_eq!(support_from(U, &rows, 21 << 16), Support::Partial(Some(NOTES[1])));
        // Support that was removed and never added again.
        assert_eq!(support_from(U, &[row(10, 20, false, U)], 15 << 16), Support::Missing);
    }

    #[test]
    fn the_note_comes_from_the_partial_range_that_covers_the_target() {
        // Two partial ranges overlap at 15: the later one covers it. At 25 only the first one does.
        let rows = [row(10, 30, true, 0), row(12, 20, true, 1), row(20, 30, true, U)];
        let at = |version: u32| support_from(30 << 16, &rows, version << 16);
        assert_eq!(at(15), Support::Partial(Some(NOTES[1])));
        assert_eq!(at(25), Support::Partial(None));
        assert_eq!(at(11), Support::Partial(Some(NOTES[0])));
    }

    #[test]
    fn notes_are_stored_once() {
        let unique: std::collections::HashSet<_> = NOTES.iter().collect();
        assert_eq!(unique.len(), NOTES.len());
    }

    #[test]
    fn does_not_report_accessors_without_get_in_the_spec_anchor() {
        let description: Vec<_> = instance_members("description")
            .map(|(feature, reportable)| (feature.as_str(), reportable))
            .collect();
        assert!(
            description.contains(&("javascript.builtins.Symbol.description", false)),
            "{description:?}"
        );
    }

    #[test]
    fn does_not_report_members_of_disposable_stacks() {
        for name in ["use", "dispose", "adopt", "defer", "move", "disposeAsync"] {
            let members: Vec<_> = instance_members(name)
                .map(|(feature, reportable)| (feature.as_str(), reportable))
                .collect();
            assert!(
                members.iter().any(|(id, _)| id.contains("DisposableStack.")),
                "{name}: {members:?}"
            );
            assert!(
                members.iter().all(|&(_, reportable)| !reportable),
                "{name}: {members:?}"
            );
        }
    }

    #[test]
    fn reads_interface_parents() {
        assert!(interface_parents("Document").contains(&"Node"));
        assert!(interface_parents("HTMLElement").contains(&"Element"));
        // @types/web 0.0.358 declares Navigator with mixins such as NavigatorID.
        assert!(interface_parents("Navigator").contains(&"NavigatorID"));
        assert_eq!(interface_parents("EventTarget"), &[] as &[&str]);
        assert_eq!(interface_parents("NoSuchInterface"), &[] as &[&str]);
    }

    #[test]
    fn interface_parents_are_sorted_for_binary_search() {
        assert!(
            generated::INTERFACE_PARENTS
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0)
        );
    }

    #[test]
    fn keeps_support_removed_only_in_a_preview_build() {
        let feature = FeatureId::find("api.WebTransportDatagramDuplexStream.incomingHighWaterMark").unwrap();
        assert_ne!(feature.full_support(Browser::Safari), UNSUPPORTED);
    }

    #[test]
    fn finds_instance_members_by_name() {
        let to_sorted: Vec<_> = instance_members("toSorted")
            .map(|(feature, reportable)| (feature.as_str(), reportable))
            .collect();
        assert!(
            to_sorted.contains(&("javascript.builtins.Array.toSorted", true)),
            "{to_sorted:?}"
        );
        assert!(instance_members("map").any(|(feature, _)| feature.as_str() == "javascript.builtins.Array.map"));
        assert!(instance_members("from").all(|(feature, _)| feature.as_str() != "javascript.builtins.Array.from"));
        assert_eq!(instance_members("noSuchMember").count(), 0);
    }

    #[test]
    fn finds_singleton_interfaces() {
        assert_eq!(singleton_interface("navigator"), Some("Navigator"));
        assert_eq!(singleton_interface("document"), Some("Document"));
        assert_eq!(singleton_interface("Intl"), None);
    }

    #[test]
    fn instance_members_are_sorted_for_binary_search() {
        assert!(
            generated::INSTANCE_MEMBERS
                .windows(2)
                .all(|pair| (pair[0].0, pair[0].1) <= (pair[1].0, pair[1].1))
        );
        assert!(generated::SINGLETONS.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }

    #[test]
    fn ranges_are_sorted_for_binary_search() {
        let key = |row: &RangeRow| (row.0, row.1, row.2, row.3, row.4);
        assert!(generated::RANGES.windows(2).all(|pair| key(&pair[0]) < key(&pair[1])));
    }

    #[test]
    fn ranges_start_before_lasting_full_support() {
        for row in generated::RANGES {
            assert!(row.2 < row.3, "{row:?}");
            assert!(row.2 < FEATURES[row.0 as usize].1[row.1 as usize], "{row:?}");
        }
    }
}
