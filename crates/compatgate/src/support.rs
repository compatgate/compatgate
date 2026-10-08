//! Compares the support data of a feature with the targets.

use crate::data::{Browser, FeatureId, Support, UNSUPPORTED};
use crate::targets::Targets;

/// A set of browsers, a bit per `Browser::index`. Under one set of targets, the bits of a mask
/// are target browsers only.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct BrowserSet(u16);

impl BrowserSet {
    pub const EMPTY: Self = Self(0);

    pub fn contains(self, browser: Browser) -> bool {
        self.0 & bit(browser) != 0
    }

    pub fn insert(&mut self, browser: Browser) {
        self.0 |= bit(browser);
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Every browser of `self` is in `other`.
    pub fn is_subset(self, other: Self) -> bool {
        self.0 & !other.0 == 0
    }

    pub fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

impl FromIterator<Browser> for BrowserSet {
    fn from_iter<I: IntoIterator<Item = Browser>>(browsers: I) -> Self {
        let mut set = Self::EMPTY;
        for browser in browsers {
            set.insert(browser);
        }
        set
    }
}

fn bit(browser: Browser) -> u16 {
    1 << browser.index()
}

/// Support of one feature under the targets.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TargetSupport {
    /// The absence mask: target browsers that lack the feature in some version from their lowest target
    /// version on. Empty when the feature has no gap in the target browsers. A browser outside the
    /// targets is never in the mask.
    pub missing: BrowserSet,
    /// Target browsers with only partial support from their lowest target version on.
    pub partial: BrowserSet,
}

impl TargetSupport {
    /// Every target browser supports the feature fully.
    pub fn is_supported(self) -> bool {
        self.missing.is_empty() && self.partial.is_empty()
    }

    /// Target browsers without full support: missing or partial.
    pub fn gaps(self) -> BrowserSet {
        self.missing.union(self.partial)
    }
}

/// `TargetSupport` of every feature, indexed by feature. One set of targets builds it once:
/// detectors ask it for every use, and the data lookup costs a binary search per target browser.
#[derive(Clone, PartialEq, Eq)]
pub struct SupportTable {
    features: Box<[TargetSupport]>,
}

impl SupportTable {
    pub fn new(minimum: &[(Browser, u32)]) -> Self {
        let features = FeatureId::all()
            .map(|feature| {
                let mut support = TargetSupport::default();
                for &(browser, target) in minimum {
                    match feature.support_from(browser, target) {
                        Support::Full => {}
                        Support::Partial(_) => support.partial.insert(browser),
                        Support::Missing => support.missing.insert(browser),
                    }
                }
                support
            })
            .collect();
        Self { features }
    }

    /// A table in which every feature is missing in every browser. Detector tests use it to see
    /// every use that a detector finds.
    #[cfg(test)]
    pub fn missing_everything() -> Self {
        Self::missing_except(&[])
    }

    /// A table in which every feature but `supported` is missing in every browser.
    #[cfg(test)]
    pub fn missing_except(supported: &[FeatureId]) -> Self {
        let all = Browser::ALL.into_iter().collect();
        Self {
            features: FeatureId::all()
                .map(|feature| TargetSupport {
                    missing: if supported.contains(&feature) {
                        BrowserSet::EMPTY
                    } else {
                        all
                    },
                    partial: BrowserSet::EMPTY,
                })
                .collect(),
        }
    }

    pub fn get(&self, feature: FeatureId) -> TargetSupport {
        self.features[feature.index()]
    }
}

impl std::fmt::Debug for SupportTable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let unsupported = self.features.iter().filter(|support| !support.is_supported()).count();
        write!(
            formatter,
            "SupportTable {{ {unsupported} of {} not supported }}",
            self.features.len()
        )
    }
}

/// A target browser that lacks full support.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gap {
    pub browser: Browser,
    /// The lowest version of the browser in the targets.
    pub target: u32,
    /// The first version from which full support lasts to the latest release, if any.
    pub since: Option<u32>,
    /// The BCD note for partial support, if the target has partial support and BCD explains it.
    pub note: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Supported,
    /// Every target and its later versions have at least partial support, and some have only partial support.
    Partial(Vec<Gap>),
    /// Some targets have no support. Lists only those targets.
    Unsupported(Vec<Gap>),
}

/// The verdict from the table of the targets. Only a feature that is not supported reads the data again,
/// for the versions and the note of each gap.
pub fn evaluate(feature: FeatureId, targets: &Targets) -> Verdict {
    let support = targets.support(feature);
    if support.is_supported() {
        return Verdict::Supported;
    }
    let partial = support.missing.is_empty();
    let browsers = if partial { support.partial } else { support.missing };
    let gaps = targets
        .minimum()
        .iter()
        .filter(|&&(browser, _)| browsers.contains(browser))
        .map(|&(browser, target)| {
            let full = feature.full_support(browser);
            let note = match feature.support_from(browser, target) {
                Support::Partial(note) if partial => note,
                _ => None,
            };
            Gap {
                browser,
                target,
                since: (full != UNSUPPORTED).then_some(full),
                note,
            }
        })
        .collect();
    if partial {
        Verdict::Partial(gaps)
    } else {
        Verdict::Unsupported(gaps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::encode_version;

    fn targets(query: &str) -> Targets {
        Targets::resolve(query).unwrap()
    }

    fn feature(id: &str) -> FeatureId {
        FeatureId::find(id).unwrap()
    }

    const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

    /// The verdict straight from the data, without the table: the algorithm before the table existed.
    fn reference(feature: FeatureId, targets: &Targets) -> Verdict {
        let mut unsupported = Vec::new();
        let mut partial = Vec::new();
        for &(browser, target) in targets.minimum() {
            let full = feature.full_support(browser);
            let gap = Gap {
                browser,
                target,
                since: (full != UNSUPPORTED).then_some(full),
                note: None,
            };
            match feature.support_from(browser, target) {
                Support::Full => {}
                Support::Partial(note) => partial.push(Gap { note, ..gap }),
                Support::Missing => unsupported.push(gap),
            }
        }
        if !unsupported.is_empty() {
            Verdict::Unsupported(unsupported)
        } else if !partial.is_empty() {
            Verdict::Partial(partial)
        } else {
            Verdict::Supported
        }
    }

    #[test]
    fn the_table_of_the_targets_matches_the_data_for_every_feature() {
        for query in [
            QUERY,
            "defaults",
            "Chrome >= 40, Safari >= 9, Firefox >= 30, Samsung >= 4",
        ] {
            let targets = targets(query);
            for id in crate::data::feature_ids() {
                let feature = feature(id);
                let expected = reference(feature, &targets);
                assert_eq!(evaluate(feature, &targets), expected, "{query}: {id}");
                let (mut missing, mut partial) = (BrowserSet::EMPTY, BrowserSet::EMPTY);
                for &(browser, target) in targets.minimum() {
                    match feature.support_from(browser, target) {
                        Support::Full => {}
                        Support::Partial(_) => partial.insert(browser),
                        Support::Missing => missing.insert(browser),
                    }
                }
                let support = targets.support(feature);
                assert_eq!((support.missing, support.partial), (missing, partial), "{query}: {id}");
                assert_eq!(
                    targets.is_supported(feature),
                    expected == Verdict::Supported,
                    "{query}: {id}"
                );
            }
        }
    }

    #[test]
    fn feature_missing_in_one_browser_is_unsupported() {
        assert_eq!(
            evaluate(feature("api.structuredClone"), &targets(QUERY)),
            Verdict::Unsupported(vec![Gap {
                browser: Browser::Chrome,
                target: encode_version("97").unwrap(),
                since: encode_version("98"),
                note: None,
            }])
        );
    }

    #[test]
    fn segmenter_is_unsupported_in_firefox_115() {
        let Verdict::Unsupported(gaps) = evaluate(feature("javascript.builtins.Intl.Segmenter"), &targets(QUERY))
        else {
            panic!("expected Unsupported");
        };
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].browser, Browser::Firefox);
        assert_eq!(gaps[0].since, encode_version("125"));
    }

    #[test]
    fn feature_present_in_all_targets_is_supported() {
        assert_eq!(
            evaluate(feature("javascript.builtins.Array.at"), &targets(QUERY)),
            Verdict::Supported
        );
    }

    #[test]
    fn partial_gap_carries_the_note_for_the_target() {
        let Verdict::Partial(gaps) = evaluate(feature("api.BarcodeDetector"), &targets("Chrome >= 97")) else {
            panic!("expected Partial");
        };
        assert!(gaps[0].note.is_some_and(|note| note.contains("ChromeOS")), "{gaps:?}");
    }

    #[test]
    fn partial_support_that_a_later_partial_statement_replaced_is_partial() {
        // BCD: Chrome supports BarcodeDetector partially from 83 to 88, and partially again from 88.
        let Verdict::Partial(gaps) = evaluate(feature("api.BarcodeDetector"), &targets("Chrome >= 85")) else {
            panic!("expected Partial");
        };
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].since, None);
        // The note comes from the statement that covers Chrome 85.
        assert_eq!(gaps[0].note, Some("Supported on macOS only."));
    }

    #[test]
    fn support_that_was_removed_and_never_added_again_is_unsupported() {
        // BCD: Firefox supported BatteryManager from 43 to 52 and has not supported it since.
        let verdict = evaluate(feature("api.BatteryManager"), &targets("Firefox >= 115"));
        assert_eq!(
            verdict,
            Verdict::Unsupported(vec![Gap {
                browser: Browser::Firefox,
                target: encode_version("115").unwrap(),
                since: None,
                note: None,
            }])
        );
        // BCD: Firefox supported `CompositionEvent.locale` from 9 to 143. Firefox 115 has it, later versions do not.
        let verdict = evaluate(feature("api.CompositionEvent.locale"), &targets("Firefox >= 115"));
        assert!(matches!(verdict, Verdict::Unsupported(_)), "{verdict:?}");
    }

    #[test]
    fn only_partial_support_gives_partial() {
        let verdict = evaluate(feature("api.BarcodeDetector"), &targets("Chrome >= 97"));
        assert!(
            matches!(verdict, Verdict::Partial(ref gaps) if gaps[0].browser == Browser::Chrome),
            "{verdict:?}"
        );
    }
}
