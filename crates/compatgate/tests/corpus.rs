//! Runs the snippets in `tests/corpus` and compares the findings with the expectations in their
//! comments, line by line. `tests/corpus/README.md` describes the format. `BLESS=1 cargo test --test
//! corpus` writes the current findings into the expectations instead.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use compatgate::allow::AllowList;
use compatgate::targets::Targets;
use compatgate::{Confidence, Finding, check};
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

const DEFAULT_TARGETS: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";
const TARGETS: &str = "// targets:";
const EXPECT: &str = "//~";
const EXTENSIONS: [&str; 8] = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

#[test]
fn corpus() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/corpus");
    let bless = std::env::var("BLESS").is_ok_and(|value| value == "1");
    let mut files = Vec::new();
    collect(&root, &mut files);
    files.sort();
    // Differences between findings and expectations, which `BLESS=1` accepts, and problems that it cannot fix.
    let mut report = String::new();
    let mut errors = String::new();
    let mut cases = 0;
    for path in &files {
        let name = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let source = std::fs::read_to_string(path).unwrap();
        match run(&name, &source) {
            Ok(file) if file.lines.is_empty() => {
                let _ = write!(errors, "\n{name}: no `{EXPECT}` expectations");
            }
            Ok(file) => {
                cases += file.lines.iter().filter(|line| line.expected.is_some()).count();
                for line in file.lines.iter().filter(|line| !line.matches()) {
                    let _ = write!(
                        report,
                        "\n{name}:{}\n    {}\n  - {}\n  + {}\n",
                        line.number,
                        line.code.trim(),
                        line.expected.as_deref().unwrap_or("(no `//~`)"),
                        line.found
                    );
                }
                if bless {
                    let blessed = file.blessed(&source);
                    if blessed != source {
                        std::fs::write(path, blessed).unwrap();
                    }
                }
            }
            Err(error) => {
                let _ = write!(errors, "\n{name}: {error}");
            }
        }
    }
    assert!(cases > 0, "no expectations in {}", root.display());
    assert!(errors.is_empty(), "the corpus has errors:{errors}");
    assert!(
        bless || report.is_empty(),
        "the findings differ from the expectations (- expected, + found). Run with BLESS=1 to accept them.\n{report}"
    );
}

fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect(&path, files);
        } else if path
            .extension()
            .is_some_and(|extension| EXTENSIONS.iter().any(|known| extension == *known))
        {
            files.push(path);
        }
    }
}

struct File {
    lines: Vec<Line>,
}

/// A line with an expectation or with a finding.
struct Line {
    /// Starts at 1.
    number: u32,
    /// The code before the expectation.
    code: String,
    /// The expectation as written, normalized. `None` when the line has no `//~`.
    expected: Option<String>,
    /// The findings in the same form.
    found: String,
}

impl Line {
    fn matches(&self) -> bool {
        self.expected.as_deref() == Some(self.found.as_str())
    }
}

impl File {
    /// The source with every expectation replaced by the findings of its line. A line with findings
    /// and no expectation gets one.
    fn blessed(&self, source: &str) -> String {
        let mut lines: Vec<String> = source.split('\n').map(str::to_string).collect();
        for line in &self.lines {
            let text = &mut lines[line.number as usize - 1];
            *text = match find_marker(text) {
                Some(start) => format!("{}{EXPECT} {}", &text[..start], line.found),
                None => format!("{} {EXPECT} {}", text.trim_end(), line.found),
            };
        }
        lines.join("\n")
    }
}

fn run(name: &str, source: &str) -> Result<File, String> {
    let errors = syntax_errors(name, source);
    if !errors.is_empty() {
        return Err(format!("the file is not a valid program: {}", errors.join("; ")));
    }
    let query = source
        .lines()
        .next()
        .and_then(|first| first.strip_prefix(TARGETS))
        .map_or(DEFAULT_TARGETS, str::trim);
    let targets = Targets::resolve(query).map_err(|error| error.to_string())?;
    let findings = check(source, name, &targets, &AllowList::empty())
        .map_err(|error| error.to_string())?
        .findings;
    let mut by_line: BTreeMap<u32, Vec<&Finding>> = BTreeMap::new();
    for finding in &findings {
        by_line.entry(finding.start.line).or_default().push(finding);
    }
    let mut lines = Vec::new();
    for (index, text) in source.lines().enumerate() {
        let number = index as u32 + 1;
        let findings = by_line.remove(&number);
        let found = render(findings.as_deref().unwrap_or_default());
        let (code, expected) = match find_marker(text) {
            Some(start) => {
                let expected = normalize(&text[start + EXPECT.len()..])
                    .map_err(|error| format!("line {number}: {error}: {}", text.trim()))?;
                (&text[..start], Some(expected))
            }
            // A finding on a line without an expectation is a difference too.
            None if findings.is_some() => (text, None),
            None => continue,
        };
        lines.push(Line {
            number,
            code: code.to_string(),
            expected,
            found,
        });
    }
    if let Some(number) = by_line.keys().next() {
        return Err(format!("a finding on line {number}, past the end of the file"));
    }
    Ok(File { lines })
}

/// The start of the expectation: the last `//~` at the line start or after whitespace. `//~` inside
/// a string or quoted in a comment follows other characters, as in `'//~'`.
fn find_marker(text: &str) -> Option<usize> {
    text.rmatch_indices(EXPECT)
        .map(|(start, _)| start)
        .find(|&start| text[..start].chars().next_back().is_none_or(char::is_whitespace))
}

/// The expectation in the form of `render`: items separated by `; `, words by one space.
fn normalize(expectation: &str) -> Result<String, String> {
    let items: Vec<String> = expectation
        .split(';')
        .map(|item| item.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|item| !item.is_empty())
        .collect();
    if items.is_empty() {
        return Err("an empty expectation; write `none` for a line without findings".to_string());
    }
    if items == ["none"] {
        return Ok("none".to_string());
    }
    for item in &items {
        let words: Vec<&str> = item.split(' ').collect();
        let well_formed = match words.as_slice() {
            [column, _, confidence] => {
                column
                    .strip_prefix('@')
                    .is_some_and(|number| number.parse::<u32>().is_ok())
                    && CONFIDENCES.contains(confidence)
            }
            [_, confidence] => CONFIDENCES.contains(confidence),
            _ => false,
        };
        if !well_formed {
            return Err(format!(
                "`{item}` is not `[@column] feature confidence`, with confidence one of {CONFIDENCES:?}"
            ));
        }
    }
    Ok(items.join("; "))
}

const CONFIDENCES: [&str; 3] = ["exact", "heuristic", "partial"];

/// The findings of one line, in the order of `check`. A finding gets its column, counted from 1
/// in UTF-16 units, when the line has another finding of the same feature.
fn render(findings: &[&Finding]) -> String {
    if findings.is_empty() {
        return "none".to_string();
    }
    let items: Vec<String> = findings
        .iter()
        .map(|finding| {
            let confidence = match finding.confidence {
                Confidence::Exact => "exact",
                Confidence::Heuristic => "heuristic",
                Confidence::Partial => "partial",
            };
            let repeated = findings.iter().filter(|other| other.feature == finding.feature).count() > 1;
            match repeated {
                true => format!("@{} {} {confidence}", finding.start.column + 1, finding.feature),
                false => format!("{} {confidence}", finding.feature),
            }
        })
        .collect();
    items.join("; ")
}

/// Errors that a stricter parser would report: a name declared twice, for example. Snippets share
/// a file, so a file must stay a valid program for other tools that read the corpus.
fn syntax_errors(name: &str, source: &str) -> Vec<String> {
    let Ok(source_type) = SourceType::from_path(name.to_lowercase()) else {
        return vec![format!("unknown extension of {name}")];
    };
    let allocator = Allocator::default();
    // `check` parses JSX in plain JavaScript files too.
    let source_type = match source_type.is_javascript() {
        true => source_type.with_jsx(true),
        false => source_type,
    };
    let parsed = Parser::new(&allocator, source, source_type)
        .with_options(ParseOptions {
            allow_return_outside_function: true,
            ..ParseOptions::default()
        })
        .parse();
    let semantic = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parsed.program);
    parsed
        .diagnostics
        .errors()
        .chain(semantic.diagnostics.errors())
        .map(|error| error.message.to_string())
        .collect()
}

#[test]
fn the_expectation_is_the_last_marker_after_whitespace() {
    assert_eq!(find_marker("x; //~ none"), Some(3));
    assert_eq!(find_marker("f('//~ a'); //~ none"), Some(12));
    assert_eq!(find_marker("//~ none"), Some(0));
    // A marker inside a string or quoted in prose follows other characters.
    assert_eq!(find_marker("f('//~');"), None);
    assert_eq!(find_marker("// Each `//~` holds the result."), None);
}

#[test]
fn a_finding_on_a_line_without_a_marker_is_a_difference() {
    let source = "x;\nstructuredClone(1);\n";
    let file = run("a.js", source).unwrap();
    assert_eq!(file.lines.len(), 1);
    let line = &file.lines[0];
    assert_eq!((line.number, line.expected.as_deref()), (2, None));
    assert_eq!(line.found, "api.structuredClone exact");
    assert_eq!(
        file.blessed(source),
        "x;\nstructuredClone(1); //~ api.structuredClone exact\n"
    );
}
