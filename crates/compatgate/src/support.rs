//! Compares the support data of a feature with the targets.

use crate::data::{Browser, FeatureId, Support, UNSUPPORTED};
use crate::targets::Targets;

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

pub fn evaluate(feature: FeatureId, targets: &Targets) -> Verdict {
    let mut unsupported = Vec::new();
    let mut partial = Vec::new();
    for &(browser, target) in targets.minimum() {
        let support = feature.support_from(browser, target);
        if support == Support::Full {
            continue;
        }
        let full = feature.full_support(browser);
        let gap = Gap {
            browser,
            target,
            since: (full != UNSUPPORTED).then_some(full),
            note: None,
        };
        match support {
            Support::Partial(note) => partial.push(Gap { note, ..gap }),
            _ => unsupported.push(gap),
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
