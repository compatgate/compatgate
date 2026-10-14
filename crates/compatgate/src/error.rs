use std::fmt;

use crate::position::Position;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The browsers of the targets are invalid or have no compatibility data.
    Targets(String),
    /// An `allow` entry is invalid.
    Allow(String),
    /// The source cannot be parsed.
    Parse(ParseError),
    /// The extension of the filename selects no parser: `a.vue`, `a.css`, a bundler id `a.ts?v=1`.
    UnsupportedFile(String),
}

/// Why the source cannot be parsed and where. The message holds no position, so a linter or a bundler
/// can show the position in its own format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    /// The first position of the error.
    pub position: Position,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Targets(message) => write!(formatter, "invalid targets: {message}"),
            Error::Allow(message) => write!(formatter, "invalid allow entry: {message}"),
            Error::Parse(error) => write!(
                formatter,
                "cannot parse: {}:{}: {}",
                error.position.line,
                error.position.column + 1,
                error.message
            ),
            Error::UnsupportedFile(message) => write!(formatter, "unsupported file: {message}"),
        }
    }
}

impl std::error::Error for Error {}
