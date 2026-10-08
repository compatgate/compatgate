//! Finds JavaScript syntax and APIs that the browsers of a browserslist query do not support.

/// Adds steps to a counter of `counters::Steps`: `count!(guards)` adds one, `count!(guards, n)` adds `n`.
/// Expands to nothing outside tests and without the `counters` feature.
macro_rules! count {
    ($field:ident) => {
        count!($field, 1)
    };
    ($field:ident, $steps:expr) => {
        #[cfg(any(test, feature = "counters"))]
        $crate::counters::add(|steps| steps.$field += $steps);
    };
}

pub mod allow;
mod check;
#[cfg(any(test, feature = "counters"))]
pub mod counters;
pub mod data;
mod detect;
mod error;
pub mod position;
pub mod support;
pub mod targets;

pub use check::{CheckOutput, Confidence, Finding, Kind, check};
pub use error::Error;
