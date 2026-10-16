//! Browser support data compiled from @mdn/browser-compat-data.

// The generator writes this file. Formatting it would make it differ from the generator output,
// and lints about long numeric literals would report every row of the tables.
#[rustfmt::skip]
#[allow(clippy::all)]
mod generated;

pub use generated::BCD_VERSION;
use generated::{FEATURES, GLOBALS, INSTANCE_MEMBERS, MEMBER_OBJECTS, MEMBER_ROWS, NAME_STARTS, NAMES, NOTES, RANGES};

/// A row of `RANGES`: feature index, browser column, the range `[first version, version of removal)`,
/// whether the support is partial, index into `NOTES` or `UNSUPPORTED`. A range without a removal
/// ends at `UNSUPPORTED`. The rows of a browser start before the version from which full support lasts.
type RangeRow = (u32, u8, u32, u32, bool, u32);

/// Version value for "not supported". It is larger than any real version.
pub(crate) const UNSUPPORTED: u32 = u32::MAX;

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

    pub(crate) fn from_browserslist(name: &str) -> Option<Self> {
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
    /// Every feature, in the order of the ids.
    pub(crate) fn all() -> impl Iterator<Item = Self> {
        (0..FEATURES.len() as u32).map(Self)
    }

    /// The position of the feature in the order of the ids. Tables of one entry per feature use it.
    pub(crate) fn index(self) -> usize {
        self.0 as usize
    }

    /// The feature with an id that the code names, found at compile time. Call it only in a `const`
    /// item: there an id that the data lacks fails the build, and at run time it would panic.
    pub(crate) const fn known(id: &str) -> Self {
        match Self::lookup(id) {
            Some(feature) => feature,
            None => panic!("the feature is not in the BCD data"),
        }
    }

    /// `find` for `known`: a binary search that a `const` item can run.
    const fn lookup(id: &str) -> Option<Self> {
        let (mut low, mut high) = (0, FEATURES.len());
        while low < high {
            let middle = low + (high - low) / 2;
            match compare(FEATURES[middle].0, id) {
                std::cmp::Ordering::Less => low = middle + 1,
                std::cmp::Ordering::Greater => high = middle,
                std::cmp::Ordering::Equal => return Some(Self(middle as u32)),
            }
        }
        None
    }

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
    pub(crate) fn full_support(self, browser: Browser) -> u32 {
        FEATURES[self.0 as usize].1[browser.index()]
    }

    /// Support in `target` and every later version of `browser`.
    pub fn support_from(self, browser: Browser, target: u32) -> Support {
        let since = self.full_support(browser);
        // Most features are fully supported in a target, and the ranges cost a binary search.
        if since <= target {
            return Support::Full;
        }
        support_from(since, browser_rows(RANGES, self.0, browser.index() as u8), target)
    }
}

impl FeatureId {
    /// The first version from `target` on with any support, partial or full, or `UNSUPPORTED`.
    pub(crate) fn first_support(self, browser: Browser, target: u32) -> u32 {
        browser_rows(RANGES, self.0, browser.index() as u8)
            .iter()
            .filter(|row| row.3 > target)
            .map(|row| row.2.max(target))
            .fold(self.full_support(browser).max(target), u32::min)
    }
}

/// `Ord` of `str` for a `const fn`: byte by byte, then by length.
const fn compare(left: &str, right: &str) -> std::cmp::Ordering {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    let mut index = 0;
    while index < left.len() && index < right.len() {
        if left[index] != right[index] {
            return if left[index] < right[index] {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        index += 1;
    }
    if left.len() < right.len() {
        std::cmp::Ordering::Less
    } else if left.len() > right.len() {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

/// Support of a feature in a version of a browser and every later version.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    /// Full support without a gap.
    Full,
    /// Full or partial support without a gap, and partial in some versions. The note is the BCD text
    /// of the partial statement that covers the version, or of the first partial statement after it.
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
    let note = note_row(rows, target).and_then(|row| (row.5 != UNSUPPORTED).then(|| NOTES[row.5 as usize]));
    Support::Partial(note)
}

/// The partial range whose note describes support from `target` on: the latest partial range that covers
/// `target`, or else the first partial range after it. A partial range that ended before `target` does not
/// describe any version from `target` on, so its note would mislead.
fn note_row(rows: &[RangeRow], target: u32) -> Option<&RangeRow> {
    rows.iter()
        .rev()
        .find(|row| row.4 && row.2 <= target && target < row.3)
        .or_else(|| rows.iter().find(|row| row.4 && row.2 > target))
}

pub fn feature_ids() -> impl Iterator<Item = &'static str> {
    FEATURES.iter().map(|(id, _)| *id)
}

/// The length of the longest feature id, in bytes.
pub(crate) fn longest_id() -> usize {
    static LONGEST: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *LONGEST.get_or_init(|| FEATURES.iter().map(|(id, _)| id.len()).max().unwrap_or(0))
}

/// The ids that start with `prefix`, in order.
pub(crate) fn ids_with_prefix(prefix: &str) -> impl Iterator<Item = &'static str> + '_ {
    let start = FEATURES.partition_point(|&(id, _)| id < prefix);
    FEATURES[start..]
        .iter()
        .map(|&(id, _)| id)
        .take_while(move |id| id.starts_with(prefix))
}

/// Instance members with this name, with a flag that tells whether a finding may name the member.
/// Methods of JavaScript builtins can be findings. Other members only make a name ambiguous:
/// Web API members, accessors, and methods of `DisposableStack` and `AsyncDisposableStack`.
pub(crate) fn instance_members(name: &str) -> impl Iterator<Item = (FeatureId, bool)> {
    let start = INSTANCE_MEMBERS.partition_point(|&(member, _, _)| member < name);
    INSTANCE_MEMBERS[start..]
        .iter()
        .take_while(move |&&(member, _, _)| member == name)
        .map(|&(_, feature, reportable)| (FeatureId(feature), reportable))
}

/// Every name of `INSTANCE_MEMBERS`, once, in order.
pub(crate) fn instance_member_names() -> impl Iterator<Item = &'static str> {
    INSTANCE_MEMBERS
        .iter()
        .enumerate()
        .filter(|&(index, &(name, _, _))| index == 0 || INSTANCE_MEMBERS[index - 1].0 != name)
        .map(|(_, &(name, _, _))| name)
}

/// No feature in a row of `GLOBALS`.
const NO_FEATURE: u16 = u16::MAX;

/// Name `index` of `NAMES`.
fn name(index: usize) -> &'static str {
    &NAMES[NAME_STARTS[index] as usize..NAME_STARTS[index + 1] as usize]
}

/// The index of `text` in `NAMES`. The names are sorted by bytes, so the index order is the string order.
fn name_index(text: &str) -> Option<u16> {
    let (mut low, mut high) = (0, NAME_STARTS.len() - 1);
    while low < high {
        let middle = low + (high - low) / 2;
        match name(middle).cmp(text) {
            std::cmp::Ordering::Less => low = middle + 1,
            std::cmp::Ordering::Greater => high = middle,
            std::cmp::Ordering::Equal => return Some(middle as u16),
        }
    }
    None
}

/// The feature of a bare global name: `structuredClone`, `Array`, `when`. For `new X()` (`is_new`) the
/// constructor entry `api.X.X` is more precise than the interface. A builtin wins over an interface, and
/// members of the global object come last: `name` is `api.Window.name`, and `when` is inherited,
/// `api.EventTarget.when`. The generator resolves every name, so a lookup is one binary search.
///
/// With BCD 8.1.4 and @types/web 0.0.358 the parents of `Window` add only the members of `EventTarget`.
/// A data update that gives the mixin parents BCD rows adds bare names here;
/// `the_parents_of_window_add_only_the_event_target_members` in the globals detector lists them.
pub(crate) fn global_feature(name: &str, is_new: bool) -> Option<FeatureId> {
    let name = name_index(name)?;
    let index = GLOBALS.binary_search_by_key(&name, |&(global, _, _)| global).ok()?;
    let (_, plain, constructed) = GLOBALS[index];
    let feature = if is_new { constructed } else { plain };
    (feature != NO_FEATURE).then_some(FeatureId(u32::from(feature)))
}

/// The feature of `object.member`: a member of the interface of a singleton such as `navigator`, its own
/// or inherited (`document.addEventListener` is `api.EventTarget.addEventListener`), or a static member
/// such as `Object.groupBy` or `BarcodeDetector.getSupportedFormats`.
pub(crate) fn member_feature(object: &str, member: &str) -> Option<FeatureId> {
    let (object, member) = (name_index(object)?, name_index(member)?);
    let index = MEMBER_OBJECTS.binary_search_by_key(&object, |&(name, _)| name).ok()?;
    let first = MEMBER_OBJECTS[index].1 as usize;
    let end = MEMBER_OBJECTS
        .get(index + 1)
        .map_or(MEMBER_ROWS.len(), |&(_, next)| next as usize);
    let rows = &MEMBER_ROWS[first..end];
    let row = rows.binary_search_by_key(&member, |&(name, _)| name).ok()?;
    Some(FeatureId(u32::from(rows[row].1)))
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
    fn finds_a_known_feature_at_compile_time() {
        const CLONE: FeatureId = FeatureId::known("api.structuredClone");
        assert_eq!(Some(CLONE), FeatureId::find("api.structuredClone"));
        for id in feature_ids() {
            assert_eq!(FeatureId::lookup(id).map(FeatureId::as_str), Some(id));
        }
        assert_eq!(FeatureId::lookup("api.DoesNotExist"), None);
        assert_eq!(compare("a.b", "a.bc"), std::cmp::Ordering::Less);
        assert_eq!(compare("a.c", "a.bc"), std::cmp::Ordering::Greater);
        assert_eq!(compare("a.b", "a.b"), std::cmp::Ordering::Equal);
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
        // Full support covers 22. The partial range before it has ended, so the note is the one of the next partial range.
        assert_eq!(at(22), Support::Partial(Some(NOTES[1])));
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
    fn full_support_at_the_target_takes_the_note_of_the_next_partial_range() {
        // Full 10–20, partial 20–25 with note 0, partial 25–30 with note 1, full from 30.
        let rows = [row(10, 20, false, U), row(20, 25, true, 0), row(25, 30, true, 1)];
        assert_eq!(note_row(&rows, 15 << 16), Some(&rows[1]));
        assert_eq!(note_row(&rows, 22 << 16), Some(&rows[1]));
        assert_eq!(note_row(&rows, 27 << 16), Some(&rows[2]));
        assert_eq!(
            support_from(30 << 16, &rows, 15 << 16),
            Support::Partial(Some(NOTES[0]))
        );
        // Only full support from the target on: there is no partial range to take a note from.
        assert_eq!(note_row(&[row(10, 20, false, U)], 15 << 16), None);
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
    fn names_are_sorted_and_found() {
        let count = generated::NAME_STARTS.len() - 1;
        assert_eq!(generated::NAME_STARTS[count] as usize, generated::NAMES.len());
        assert!((1..count).all(|index| name(index - 1) < name(index)));
        for index in 0..count {
            assert_eq!(name_index(name(index)), Some(index as u16), "{}", name(index));
        }
        assert_eq!(name_index("noSuchName"), None);
        assert_eq!(name_index(""), None);
    }

    #[test]
    fn globals_and_members_are_sorted_for_binary_search() {
        assert!(generated::GLOBALS.windows(2).all(|pair| pair[0].0 < pair[1].0));
        let objects = generated::MEMBER_OBJECTS;
        assert!(
            objects
                .windows(2)
                .all(|pair| pair[0].0 < pair[1].0 && pair[0].1 < pair[1].1)
        );
        assert_eq!(objects[0].1, 0);
        for (index, &(_, first)) in objects.iter().enumerate() {
            let end = objects
                .get(index + 1)
                .map_or(generated::MEMBER_ROWS.len(), |next| next.1 as usize);
            let rows = &generated::MEMBER_ROWS[first as usize..end];
            assert!(rows.windows(2).all(|pair| pair[0].0 < pair[1].0));
        }
    }

    #[test]
    fn finds_global_features() {
        let find = |name, is_new| global_feature(name, is_new).map(FeatureId::as_str);
        assert_eq!(find("structuredClone", false), Some("api.structuredClone"));
        assert_eq!(find("ResizeObserver", false), Some("api.ResizeObserver"));
        assert_eq!(find("ResizeObserver", true), Some("api.ResizeObserver.ResizeObserver"));
        assert_eq!(find("Array", true), Some("javascript.builtins.Array"));
        assert_eq!(find("name", false), Some("api.Window.name"));
        assert_eq!(find("when", false), Some("api.EventTarget.when"));
        assert_eq!(find("noSuchThing", false), None);
        assert_eq!(find("", true), None);
    }

    #[test]
    fn finds_member_features() {
        let find = |object, member| member_feature(object, member).map(FeatureId::as_str);
        assert_eq!(find("navigator", "share"), Some("api.Navigator.share"));
        // @types/web 0.0.358 declares Document as an extension of Node.
        assert_eq!(find("document", "contains"), Some("api.Node.contains"));
        assert_eq!(find("document", "querySelector"), Some("api.Document.querySelector"));
        assert_eq!(find("Object", "groupBy"), Some("javascript.builtins.Object.groupBy"));
        assert_eq!(find("Intl", "Segmenter"), Some("javascript.builtins.Intl.Segmenter"));
        assert_eq!(
            find("BarcodeDetector", "getSupportedFormats"),
            Some("api.BarcodeDetector.getSupportedFormats_static")
        );
        assert_eq!(find("navigator", "noSuchThing"), None);
        assert_eq!(find("Intl", "Segmenter.x"), None);
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
    fn instance_members_are_sorted_for_binary_search() {
        assert!(
            generated::INSTANCE_MEMBERS
                .windows(2)
                .all(|pair| (pair[0].0, pair[0].1) <= (pair[1].0, pair[1].1))
        );
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
