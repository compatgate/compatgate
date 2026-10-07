//! Browser support data compiled from @mdn/browser-compat-data.

// The generator writes this file. Formatting it would make it differ from the generator output.
#[rustfmt::skip]
mod generated;

pub use generated::BCD_VERSION;
use generated::{FEATURES, PARTIAL};

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
    /// Same order as `BROWSERS` in scripts/generate-data.mjs.
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

    /// First version with full support, or `UNSUPPORTED`.
    pub fn full_support(self, browser: Browser) -> u32 {
        FEATURES[self.0 as usize].1[browser.index()]
    }

    /// First version with partial support, or `UNSUPPORTED`.
    pub fn partial_support(self, browser: Browser) -> u32 {
        let key = (self.0, browser.index() as u8);
        PARTIAL
            .binary_search_by(|&(feature, column, _)| (feature, column).cmp(&key))
            .map(|index| PARTIAL[index].2)
            .unwrap_or(UNSUPPORTED)
    }
}

pub fn feature_ids() -> impl Iterator<Item = &'static str> {
    FEATURES.iter().map(|(id, _)| *id)
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
        assert_ne!(feature.partial_support(Browser::Chrome), UNSUPPORTED);
        assert_eq!(feature.partial_support(Browser::Firefox), UNSUPPORTED);
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
    fn partial_support_is_sorted_for_binary_search() {
        assert!(
            generated::PARTIAL
                .windows(2)
                .all(|pair| (pair[0].0, pair[0].1) < (pair[1].0, pair[1].1))
        );
    }
}
