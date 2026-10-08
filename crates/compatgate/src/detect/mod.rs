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

/// What happens at the use in a browser without the feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Reading the name throws `ReferenceError`: `structuredClone`, `navigation`.
    Global,
    /// Reading the member gives `undefined`: `navigator.share`, `arr.toSorted`.
    Member,
    /// The call itself throws: `new RegExp('(?<=a)')`.
    Call,
    /// Syntax: the file does not parse, so no check in the code helps.
    Parse,
}

/// One use of a BCD feature in the source. Detectors create uses only for features that the targets
/// do not support fully, so a use is a candidate for a finding. `'t` is the lifetime of the targets.
pub struct Use<'t> {
    pub feature: FeatureId,
    /// Other features the same code may use. A heuristic detector cannot tell them apart,
    /// so an `allow` entry for any of them suppresses the finding.
    pub alternatives: &'t [FeatureId],
    pub kind: Kind,
    pub confidence: Confidence,
    pub origin: Origin,
    pub span: Span,
    /// The AST node of the use. Guard detection walks up from it and reads the keys of the use from it.
    pub node: NodeId,
}

impl Use<'_> {
    pub fn new(feature: FeatureId, kind: Kind, origin: Origin, span: Span, node: NodeId) -> Self {
        Self {
            feature,
            alternatives: &[],
            kind,
            confidence: Confidence::Exact,
            origin,
            span,
            node,
        }
    }
}
