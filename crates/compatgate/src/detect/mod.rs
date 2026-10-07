//! Detectors turn the AST and scope data into feature uses. Each detector is independent;
//! `guards` then removes the uses that the code protects with a feature check.

pub mod globals;
pub mod guards;
pub mod methods;
pub mod regex;
pub mod syntax;

use oxc_semantic::NodeId;
use oxc_span::Span;

use crate::check::{Confidence, Kind};
use crate::data::FeatureId;

/// Names under which the global object is reachable. `window.X` is the global `X`.
pub(crate) const WINDOW_ALIASES: [&str; 3] = ["window", "self", "globalThis"];

/// One use of a BCD feature in the source.
pub struct Use {
    pub feature: FeatureId,
    /// Other features the same code may use. A heuristic detector cannot tell them apart,
    /// so an `allow` entry for any of them suppresses the finding.
    pub alternatives: Vec<FeatureId>,
    pub kind: Kind,
    pub confidence: Confidence,
    pub span: Span,
    /// The AST node of the use. Guard detection walks up from it.
    pub node: NodeId,
    /// Names under which code can test for the feature: `Intl.Segmenter`, `structuredClone`,
    /// `#toSorted` for a method of any object. Empty for syntax, which code cannot test for.
    pub keys: Vec<String>,
    /// The use fails at run time, so a `try` or an optional call can protect it. Parse-time syntax cannot be protected.
    pub catchable: bool,
}

impl Use {
    pub fn new(feature: FeatureId, kind: Kind, span: Span, node: NodeId) -> Self {
        Self {
            feature,
            alternatives: Vec::new(),
            kind,
            confidence: Confidence::Exact,
            span,
            node,
            keys: Vec::new(),
            catchable: kind != Kind::Syntax,
        }
    }

    pub fn with_keys(self, keys: Vec<String>) -> Self {
        Self { keys, ..self }
    }
}
