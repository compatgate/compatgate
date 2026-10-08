//! Detectors turn the AST and scope data into feature uses. Each detector is independent;
//! `guards` then removes the uses that the code protects with a feature check.

pub mod globals;
pub mod guards;
pub mod methods;
pub mod path;
pub mod regex;
pub mod slot;
pub mod syntax;

use oxc_semantic::NodeId;
use oxc_span::Span;

use crate::check::{Confidence, Kind};
use crate::data::FeatureId;

/// What happens at the use in a browser without the feature.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Reading the name throws `ReferenceError`: `structuredClone`, `navigation`.
    Global,
    /// Reading the member gives `undefined`: `navigator.share`, `window.structuredClone`.
    Member,
    /// A member of an object of unknown type, found by its name: `arr.toSorted`. Reading it gives
    /// `undefined` too, but a check names it by the name alone.
    Method,
    /// The call itself throws: `new RegExp('(?<=a)')`.
    Call,
    /// Syntax: the file does not parse, so no check in the code helps.
    Parse,
}

/// The name under which a check proves a feature present.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key<'a> {
    /// `["navigator", "share"]`, without the aliases of the global object.
    Path(Vec<&'a str>),
    /// The name of a method of any object: a check of `a.toSorted` proves `b.toSorted` too.
    Method(&'a str),
}

/// One use of a BCD feature in the source. Detectors create uses only for features that the targets
/// do not support fully, so a use is a candidate for a finding.
pub struct Use<'a> {
    pub feature: FeatureId,
    /// Other features the same code may use. A heuristic detector cannot tell them apart,
    /// so an `allow` entry for any of them suppresses the finding.
    pub alternatives: &'static [FeatureId],
    pub kind: Kind,
    pub confidence: Confidence,
    pub origin: Origin,
    pub span: Span,
    /// The AST node of the use: the identifier of a global, the member expression of a member or of a
    /// method, the property of a destructuring, the node of the syntax. The guards walk up from it.
    pub node: NodeId,
    /// The name under which a check proves the feature present, as the detector resolved it. `None` for
    /// a use that code cannot check: syntax and a pattern that `new RegExp` parses.
    pub key: Option<Key<'a>>,
    /// For the root of a chain: the node of the member read at the same place, when every target version
    /// without full support of the root lacks the member too. The finding of the member then tells about
    /// the root as well, so the root is no finding while the member is one.
    pub member: Option<NodeId>,
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
            key: None,
            member: None,
        }
    }
}
