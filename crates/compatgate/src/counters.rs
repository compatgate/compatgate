//! Step counters for the linearity tests. A test runs the same input shape at two sizes and checks
//! `steps ≤ c·n` at both, so a quadratic regression fails on any machine. A time budget does not:
//! a fast machine hides the regression, and a slow one fails without it.
//!
//! The counters exist only in tests and with the `counters` feature. Without them `count!` expands
//! to nothing.

use std::cell::Cell;

/// Steps of the current thread since the last `take`.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Steps {
    /// Ancestors that guard detection visits on the way from a use to the root.
    pub climb: usize,
    /// Other nodes that guard detection visits: operands of chains, statements of lists, wrappers.
    pub guards: usize,
    /// Node kinds that the ambient check inspects.
    pub ambient: usize,
    /// Position lookups and the bytes they count from a checkpoint.
    pub positions: usize,
}

thread_local! {
    static STEPS: Cell<Steps> = const {
        Cell::new(Steps {
            climb: 0,
            guards: 0,
            ambient: 0,
            positions: 0,
        })
    };
}

/// Returns the steps of the current thread and resets them.
pub fn take() -> Steps {
    STEPS.take()
}

pub(crate) fn add(update: impl FnOnce(&mut Steps)) {
    STEPS.with(|cell| {
        let mut steps = cell.get();
        update(&mut steps);
        cell.set(steps);
    });
}
