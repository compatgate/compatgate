//! Finds JavaScript syntax and APIs that the browsers of a browserslist query do not support.

pub mod allow;
mod check;
pub mod data;
mod detect;
mod error;
pub mod position;
pub mod support;
pub mod targets;

pub use check::{CheckOutput, Confidence, Finding, Kind, check};
pub use error::Error;
