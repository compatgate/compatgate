//! Compares the support data of a feature with the targets.

use crate::data::{Browser, FeatureId, UNSUPPORTED};
use crate::targets::Targets;

/// A target browser that lacks full support.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gap {
    pub browser: Browser,
    /// The lowest version of the browser in the targets.
    pub target: u32,
    /// The first version with full support, if any.
    pub since: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Supported,
    /// Every target has at least partial support, and some have only partial support.
    Partial(Vec<Gap>),
    /// Some targets have no support. Lists only those targets.
    Unsupported(Vec<Gap>),
}

pub fn evaluate(feature: FeatureId, targets: &Targets) -> Verdict {
    let mut unsupported = Vec::new();
    let mut partial = Vec::new();
    for &(browser, target) in targets.minimum() {
        let full = feature.full_support(browser);
        if full <= target {
            continue;
        }
        let gap = Gap { browser, target, since: (full != UNSUPPORTED).then_some(full) };
        if feature.partial_support(browser) <= target {
            partial.push(gap);
        } else {
            unsupported.push(gap);
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
            }])
        );
    }

    #[test]
    fn segmenter_is_unsupported_in_firefox_115() {
        let Verdict::Unsupported(gaps) = evaluate(feature("javascript.builtins.Intl.Segmenter"), &targets(QUERY)) else {
            panic!("expected Unsupported");
        };
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps[0].browser, Browser::Firefox);
        assert_eq!(gaps[0].since, encode_version("125"));
    }

    #[test]
    fn feature_present_in_all_targets_is_supported() {
        assert_eq!(evaluate(feature("javascript.builtins.Array.at"), &targets(QUERY)), Verdict::Supported);
    }

    #[test]
    fn only_partial_support_gives_partial() {
        let verdict = evaluate(feature("api.BarcodeDetector"), &targets("Chrome >= 97"));
        assert!(matches!(verdict, Verdict::Partial(ref gaps) if gaps[0].browser == Browser::Chrome), "{verdict:?}");
    }
}
