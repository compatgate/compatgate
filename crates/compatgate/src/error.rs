use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The browserslist query is invalid or selects no known browser.
    Targets(String),
    /// An `allow` entry is invalid.
    Allow(String),
    /// The source cannot be parsed.
    Parse(String),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Targets(message) => write!(formatter, "invalid targets: {message}"),
            Error::Allow(message) => write!(formatter, "invalid allow entry: {message}"),
            Error::Parse(message) => write!(formatter, "cannot parse: {message}"),
        }
    }
}

impl std::error::Error for Error {}
