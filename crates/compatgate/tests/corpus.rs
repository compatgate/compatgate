//! Runs the snippets in `tests/corpus` and compares the findings with the expectations in their
//! comments, line by line. `tests/corpus/README.md` describes the format. `BLESS=1 cargo test --test
//! corpus` writes the current findings into the expectations instead.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use compatgate::allow::{AllowEntry, AllowList};
use compatgate::targets::Targets;
use compatgate::{Confidence, Finding, check};
use oxc_allocator::Allocator;
use oxc_parser::{ParseOptions, Parser};
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;

const DEFAULT_TARGETS: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";
const TARGETS: &str = "// targets:";
const FILENAME: &str = "// filename:";
const ALLOW: &str = "// allow:";
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
                    match file.blessed(&source) {
                        Ok(blessed) if blessed != source => std::fs::write(path, blessed).unwrap(),
                        Ok(_) => {}
                        Err(error) => {
                            let _ = write!(errors, "\n{name}: {error}");
                        }
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
    /// The filename that `check` gets: its extension decides how the file parses.
    filename: String,
    lines: Vec<Line>,
}

/// A line with an expectation or with a finding.
struct Line {
    /// Starts at 1.
    number: u32,
    /// The code before the expectation.
    code: String,
    /// The byte offset of the expectation in the line.
    marker: Option<usize>,
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
    /// and no expectation gets one. An error when a new expectation would not be a comment: the line
    /// ends inside a template literal, a block comment or JSX text.
    fn blessed(&self, source: &str) -> Result<String, String> {
        let mut lines: Vec<(String, &str)> = split_lines(source)
            .into_iter()
            .map(|(text, end)| (text.to_string(), end))
            .collect();
        for line in &self.lines {
            let text = &mut lines[line.number as usize - 1].0;
            *text = match line.marker {
                Some(start) => format!("{}{EXPECT} {}", &text[..start], line.found),
                None => format!("{} {EXPECT} {}", text.trim_end(), line.found),
            };
        }
        let blessed: String = lines.into_iter().map(|(text, end)| text + end).collect();
        // Only the parser knows where a line ends inside a literal, so the result is parsed again.
        let markers = parse(&self.filename, &blessed).markers;
        let lost: Vec<String> = self
            .lines
            .iter()
            .filter(|line| !markers.contains_key(&line.number))
            .map(|line| line.number.to_string())
            .collect();
        match lost.is_empty() {
            true => Ok(blessed),
            false => Err(format!(
                "cannot add `{EXPECT}` to line {}: the line ends inside a literal or a comment",
                lost.join(", ")
            )),
        }
    }
}

/// The lines of the source with their terminators, split as `check` counts lines: at `\n`, `\r\n`, a
/// lone `\r`, U+2028 and U+2029. A line comment ends at each of them too.
fn split_lines(source: &str) -> Vec<(&str, &str)> {
    let mut lines = Vec::new();
    let mut start = 0;
    let mut chars = source.char_indices().peekable();
    while let Some((at, char)) = chars.next() {
        let end = match char {
            '\r' if chars.peek().is_some_and(|&(_, next)| next == '\n') => at + 2,
            '\n' | '\r' | '\u{2028}' | '\u{2029}' => at + char.len_utf8(),
            _ => continue,
        };
        if end == at + 2 {
            chars.next();
        }
        lines.push((&source[start..at], &source[at..end]));
        start = end;
    }
    lines.push((&source[start..], ""));
    lines
}

/// The header of a file: the comment lines at its start. They set the arguments of `check`.
struct Header {
    targets: String,
    filename: String,
    allow: Vec<AllowEntry>,
}

fn header(name: &str, lines: &[(&str, &str)]) -> Result<Header, String> {
    let mut header = Header {
        targets: DEFAULT_TARGETS.to_string(),
        filename: name.to_string(),
        allow: Vec::new(),
    };
    let mut allow = None;
    for (text, _) in lines {
        let text = text.trim_start_matches('\u{FEFF}').trim();
        if !text.starts_with("//") {
            break;
        }
        if let Some(query) = text.strip_prefix(TARGETS) {
            header.targets = query.trim().to_string();
        } else if let Some(filename) = text.strip_prefix(FILENAME) {
            header.filename = filename.trim().to_string();
        } else if let Some(entries) = text.strip_prefix(ALLOW) {
            allow = Some(entries.trim().to_string());
        }
    }
    if let Some(entries) = allow {
        // A relative glob in `files` is relative to the config, which lies beside the file by default.
        let base_dir = header.filename.rsplit_once('/').map_or("", |(directory, _)| directory);
        header.allow = allow_entries(&entries, base_dir).map_err(|error| format!("`{ALLOW}`: {error}"))?;
    }
    Ok(header)
}

/// The entries of `// allow:`: a JSON array of feature ids and of objects with the fields of an `allow`
/// entry of the binding: `feature`, `packages`, `files` and `baseDir`.
fn allow_entries(json: &str, base_dir: &str) -> Result<Vec<AllowEntry>, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| error.to_string())?;
    let strings = |value: Option<&serde_json::Value>| -> Result<Vec<String>, String> {
        value.map_or(Ok(Vec::new()), |list| {
            serde_json::from_value(list.clone()).map_err(|error| error.to_string())
        })
    };
    let items = value.as_array().ok_or("not a JSON array")?;
    items
        .iter()
        .map(|item| match item {
            serde_json::Value::String(feature) => Ok(AllowEntry {
                feature: feature.clone(),
                base_dir: base_dir.to_string(),
                ..AllowEntry::default()
            }),
            serde_json::Value::Object(fields) => {
                if let Some(unknown) = fields
                    .keys()
                    .find(|key| !["feature", "packages", "files", "baseDir"].contains(&key.as_str()))
                {
                    return Err(format!("an unknown field `{unknown}`"));
                }
                Ok(AllowEntry {
                    feature: fields
                        .get("feature")
                        .and_then(serde_json::Value::as_str)
                        .ok_or("an entry without a string `feature`")?
                        .to_string(),
                    packages: strings(fields.get("packages"))?,
                    files: strings(fields.get("files"))?,
                    base_dir: fields
                        .get("baseDir")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(base_dir)
                        .to_string(),
                })
            }
            _ => Err(format!("`{item}` is neither a feature id nor an entry")),
        })
        .collect()
}

fn run(name: &str, source: &str) -> Result<File, String> {
    let source_lines = split_lines(source);
    let Header {
        targets,
        filename,
        allow,
    } = header(name, &source_lines)?;
    let Parsed { errors, markers } = parse(&filename, source);
    if !errors.is_empty() {
        return Err(format!("the file is not a valid program: {}", errors.join("; ")));
    }
    let targets = Targets::resolve(&targets).map_err(|error| error.to_string())?;
    let allow = AllowList::new(&allow).map_err(|error| error.to_string())?;
    let findings = check(source, &filename, &targets, &allow)
        .map_err(|error| error.to_string())?
        .findings;
    let mut by_line: BTreeMap<u32, Vec<&Finding>> = BTreeMap::new();
    for finding in &findings {
        by_line.entry(finding.start.line).or_default().push(finding);
    }
    let mut lines = Vec::new();
    for (index, &(text, _)) in source_lines.iter().enumerate() {
        let number = index as u32 + 1;
        let findings = by_line.remove(&number);
        let found = render(findings.as_deref().unwrap_or_default());
        let marker = markers.get(&number).copied();
        let (code, expected) = match marker {
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
            marker,
            expected,
            found,
        });
    }
    if let Some(number) = by_line.keys().next() {
        return Err(format!("a finding on line {number}, past the end of the file"));
    }
    Ok(File { filename, lines })
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

struct Parsed {
    /// Errors that a stricter parser would report: a name declared twice, for example. Snippets share
    /// a file, so a file must stay a valid program for other tools that read the corpus.
    errors: Vec<String>,
    /// The expectations: line comments that start with `//~`, as the line number and the byte offset
    /// in the line. `//~` in a string, in a template literal or inside another comment is no expectation.
    markers: BTreeMap<u32, usize>,
}

fn parse(name: &str, source: &str) -> Parsed {
    let name = name.rsplit('/').next().unwrap_or(name);
    let Ok(source_type) = SourceType::from_path(name.to_lowercase()) else {
        return Parsed {
            errors: vec![format!("unknown extension of {name}")],
            markers: BTreeMap::new(),
        };
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
    let errors = parsed
        .diagnostics
        .errors()
        .chain(semantic.diagnostics.errors())
        .map(|error| error.message.to_string())
        .collect();
    let starts: Vec<usize> = split_lines(source)
        .iter()
        .map(|(text, _)| text.as_ptr() as usize - source.as_ptr() as usize)
        .collect();
    let markers = parsed
        .program
        .comments
        .iter()
        .filter(|comment| comment.is_line() && source[comment.span.start as usize..].starts_with(EXPECT))
        .map(|comment| {
            let start = comment.span.start as usize;
            let line = starts.partition_point(|&line_start| line_start <= start);
            (line as u32, start - starts[line - 1])
        })
        .collect();
    Parsed { errors, markers }
}

#[test]
fn an_expectation_is_a_line_comment_that_starts_with_the_marker() {
    let source = "x; //~ none\nf(' //~ a'); //~ none\n//~ none\nf('//~');\n// Each `//~` holds it.\n/* //~ none */ y;\n`\n//~ none\n`;\n";
    let markers: Vec<(u32, usize)> = parse("a.js", source).markers.into_iter().collect();
    assert_eq!(markers, [(1, 3), (2, 13), (3, 0)]);
}

#[test]
fn bless_does_not_put_an_expectation_inside_a_literal() {
    let source = "const s = `${structuredClone(1)}\n`;\n";
    let file = run("a.js", source).unwrap();
    assert_eq!(file.lines[0].expected, None);
    let error = file.blessed(source).unwrap_err();
    assert!(error.contains("line 1"), "{error}");
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
        file.blessed(source).unwrap(),
        "x;\nstructuredClone(1); //~ api.structuredClone exact\n"
    );
}

#[test]
fn lines_split_as_check_counts_them() {
    let source = "a; //~ none\r\nb;\rc;\u{2028}d;\u{2029}e;\n";
    let lines = split_lines(source);
    let texts: Vec<&str> = lines.iter().map(|(text, _)| *text).collect();
    assert_eq!(texts, ["a; //~ none", "b;", "c;", "d;", "e;", ""]);
    // Blessing keeps every terminator.
    let blessed: String = lines.iter().map(|(text, end)| format!("{text}{end}")).collect();
    assert_eq!(blessed, source);
    let source = "x;\r\nstructuredClone(1);\u{2028}y;\rstructuredClone(2); //~ none\n";
    let file = run("a.js", source).unwrap();
    let numbers: Vec<u32> = file.lines.iter().map(|line| line.number).collect();
    assert_eq!(numbers, [2, 4]);
    assert_eq!(
        file.blessed(source).unwrap(),
        "x;\r\nstructuredClone(1); //~ api.structuredClone exact\u{2028}y;\rstructuredClone(2); //~ api.structuredClone exact\n"
    );
}

#[test]
fn the_header_sets_the_filename_and_the_allow_entries() {
    let source = "// filename: /p/node_modules/x/a.js\n// allow: [{\"feature\": \"api.structuredClone\", \"packages\": [\"x\"]}]\nstructuredClone(1);\n";
    let found = run("a.js", source).unwrap();
    assert!(found.lines.is_empty());
    let error = run("a.js", "// allow: [{\"feature\": \"a\", \"file\": []}]\nx;\n")
        .err()
        .unwrap();
    assert!(error.contains("unknown field `file`"), "{error}");
}

#[test]
fn a_marker_in_a_string_after_whitespace_is_no_marker() {
    let file = run("a.js", "structuredClone(' //~ none');\n").unwrap();
    assert_eq!(file.lines.len(), 1);
    assert_eq!(file.lines[0].expected, None);
}
