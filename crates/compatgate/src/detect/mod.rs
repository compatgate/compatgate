//! Detectors turn the AST and scope data into feature uses. Each detector is independent.

pub mod globals;

use oxc_span::Span;

use crate::check::Kind;
use crate::data::FeatureId;

/// One use of a BCD feature in the source.
pub struct Use {
    pub feature: FeatureId,
    pub kind: Kind,
    pub span: Span,
}
