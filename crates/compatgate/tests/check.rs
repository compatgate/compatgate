//! Tests of the API: positions, gaps and notes, `allow`, the order of findings, file names and errors.
//! The findings of snippets are in `tests/corpus`.

use compatgate::allow::{AllowEntry, AllowList};
use compatgate::position::Position;
use compatgate::targets::Targets;
use compatgate::{Confidence, Error, Kind, ParseError, check, is_checkable};

const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

fn features(source: &str, filename: &str) -> Vec<&'static str> {
    let targets = Targets::resolve(QUERY).unwrap();
    check(source, filename, &targets, &AllowList::empty())
        .unwrap()
        .findings
        .into_iter()
        .map(|finding| finding.feature)
        .collect()
}

#[test]
fn finds_a_global_function_missing_in_a_target() {
    let targets = Targets::resolve(QUERY).unwrap();
    let output = check(
        "const a = 1;\nstructuredClone(a);\n",
        "a.js",
        &targets,
        &AllowList::empty(),
    )
    .unwrap();
    assert_eq!(output.findings.len(), 1);
    let finding = &output.findings[0];
    assert_eq!(finding.feature, "api.structuredClone");
    assert_eq!(finding.kind, Kind::Api);
    assert_eq!(finding.confidence, Confidence::Exact);
    assert_eq!(
        finding.start,
        Position {
            line: 2,
            column: 0,
            offset: 13
        }
    );
    assert_eq!(
        finding.end,
        Position {
            line: 2,
            column: 15,
            offset: 28
        }
    );
}

#[test]
fn support_that_a_later_release_replaced_is_partial() {
    // BCD: Safari has partial class fields from 14.1 to 16 and full support from 16.
    // The partial statement has a removal version, and the old generator dropped it.
    let targets = Targets::resolve(QUERY).unwrap();
    let output = check("class A { x = 1; }", "a.js", &targets, &AllowList::empty()).unwrap();
    assert_eq!(output.findings.len(), 1, "{:?}", output.findings);
    let finding = &output.findings[0];
    assert_eq!(finding.feature, "javascript.classes.public_class_fields");
    assert_eq!(finding.confidence, Confidence::Partial);
    let safari = finding
        .gaps
        .iter()
        .find(|gap| gap.browser == compatgate::data::Browser::Safari)
        .expect("Safari 15.6 has partial support");
    assert_eq!(safari.since, compatgate::data::encode_version("16"));
    assert!(
        safari.note.is_some_and(|note| note.contains("Parentheses")),
        "{safari:?}"
    );
}

#[test]
fn allow_entry_suppresses_the_finding_and_is_reported_as_used() {
    let targets = Targets::resolve(QUERY).unwrap();
    let allow = AllowList::new(&[
        AllowEntry {
            feature: "api.ResizeObserver".into(),
            ..AllowEntry::default()
        },
        AllowEntry {
            feature: "api.structuredClone".into(),
            ..AllowEntry::default()
        },
    ])
    .unwrap();
    let output = check("structuredClone(1); structuredClone(2);", "a.js", &targets, &allow).unwrap();
    assert!(output.findings.is_empty());
    assert_eq!(output.used_allow, [1]);
}

#[test]
fn allow_entry_for_another_package_does_not_suppress() {
    let targets = Targets::resolve(QUERY).unwrap();
    let allow = AllowList::new(&[AllowEntry {
        feature: "api.structuredClone".into(),
        packages: vec!["some-lib".into()],
        ..AllowEntry::default()
    }])
    .unwrap();
    let output = check("structuredClone(1);", "/p/src/a.js", &targets, &allow).unwrap();
    assert_eq!(output.findings.len(), 1);
}

#[test]
fn findings_are_sorted_by_position() {
    assert_eq!(
        features(
            "structuredClone(1);\nnew Intl.Segmenter();\nstructuredClone(2);\n",
            "a.js"
        ),
        [
            "api.structuredClone",
            "javascript.builtins.Intl.Segmenter",
            "api.structuredClone"
        ]
    );
}

fn parse_error(source: &str, filename: &str) -> ParseError {
    let targets = Targets::resolve(QUERY).unwrap();
    match check(source, filename, &targets, &AllowList::empty()) {
        Err(Error::Parse(error)) => error,
        other => panic!("expected a parse error, got {other:?}"),
    }
}

#[test]
fn syntax_error_is_a_parse_error_with_a_position() {
    let error = parse_error("const = ;", "broken.js");
    assert!(!error.message.is_empty());
    assert_eq!((error.position.line, error.position.column), (1, 6), "{error:?}");
}

#[test]
fn an_unknown_extension_is_an_unsupported_file() {
    let targets = Targets::resolve(QUERY).unwrap();
    for (filename, named) in [("/p/a.vue", "\".vue\""), ("/p/Makefile", "without an extension")] {
        let error = check("<template></template>", filename, &targets, &AllowList::empty()).unwrap_err();
        let Error::UnsupportedFile(message) = &error else {
            panic!("expected an unsupported file, got {error:?}");
        };
        assert!(message.contains(named), "{message}");
        assert!(
            !message.contains("/p/"),
            "the message does not repeat the filename: {message}"
        );
    }
}

#[test]
fn is_checkable_tells_the_files_that_check_can_parse() {
    for filename in [
        "a.js", "a.mjs", "a.cjs", "a.jsx", "a.ts", "a.mts", "a.cts", "a.tsx", "a.d.ts", "/p/A.JS",
    ] {
        assert!(is_checkable(filename), "{filename}");
    }
    // A bundler id with a query names no file: the adapter strips the query first.
    for filename in ["a.vue", "a.css", "Makefile", "a.ts?v=123", "a.ts#x"] {
        assert!(!is_checkable(filename), "{filename}");
    }
}

#[test]
fn uppercase_extension_is_accepted() {
    assert_eq!(features("structuredClone(1);", "A.JS"), ["api.structuredClone"]);
}

#[test]
fn parse_error_names_line_and_column() {
    let error = parse_error("const a = 1;\nconst = ;", "broken.js");
    assert_eq!((error.position.line, error.position.column), (2, 6), "{error:?}");
    assert_eq!(error.position.offset, 19);
    assert!(
        Error::Parse(error).to_string().contains("2:7"),
        "the message counts columns from 1"
    );
}

#[test]
fn a_range_is_utf16_offsets_into_the_source() {
    // 🐈‍⬛ is four UTF-16 units: a surrogate pair, a zero-width joiner and one more character.
    let targets = Targets::resolve(QUERY).unwrap();
    let source = "const s = \"Мяу 🐈‍⬛\";\nstructuredClone(s);";
    let output = check(source, "a.js", &targets, &AllowList::empty()).unwrap();
    let finding = &output.findings[0];
    assert_eq!((finding.start.offset, finding.end.offset), (22, 37));
    let utf16: Vec<u16> = source.encode_utf16().collect();
    let text = String::from_utf16(&utf16[finding.start.offset as usize..finding.end.offset as usize]).unwrap();
    assert_eq!(text, "structuredClone");
}

#[test]
fn a_heuristic_finding_names_the_other_members_with_the_name() {
    let targets = Targets::resolve(QUERY).unwrap();
    let output = check("list.toSorted();", "a.js", &targets, &AllowList::empty()).unwrap();
    let finding = &output.findings[0];
    let alternatives: Vec<&str> = finding.alternatives.iter().map(|id| id.as_str()).collect();
    assert!(!alternatives.is_empty(), "{finding:?}");
    assert!(!alternatives.contains(&finding.feature), "{alternatives:?}");
    assert!(
        alternatives.iter().all(|id| id.ends_with(".toSorted")),
        "{alternatives:?}"
    );
}

#[test]
fn an_exact_finding_has_no_alternatives() {
    let targets = Targets::resolve(QUERY).unwrap();
    let output = check("structuredClone(1);", "a.js", &targets, &AllowList::empty()).unwrap();
    assert!(output.findings[0].alternatives.is_empty());
}

#[test]
fn partial_findings_carry_the_bcd_note() {
    let targets = Targets::resolve("Chrome >= 97").unwrap();
    let output = check("new BarcodeDetector();", "a.js", &targets, &AllowList::empty()).unwrap();
    assert!(output.findings[0].gaps[0].note.unwrap().contains("ChromeOS"));
}

#[test]
fn allowing_another_method_with_the_same_name_suppresses_the_finding() {
    let targets = Targets::resolve(QUERY).unwrap();
    let allow = AllowList::new(&[AllowEntry {
        feature: "javascript.builtins.TypedArray.toSorted".into(),
        ..AllowEntry::default()
    }])
    .unwrap();
    let output = check("[3, 1].toSorted();", "a.js", &targets, &allow).unwrap();
    assert!(output.findings.is_empty());
    assert_eq!(output.used_allow, [0]);
}

#[test]
fn findings_at_one_position_are_sorted_by_feature() {
    let targets = Targets::resolve("Chrome >= 40").unwrap();
    let found: Vec<_> = check("/a/vy;", "a.js", &targets, &AllowList::empty())
        .unwrap()
        .findings
        .into_iter()
        .map(|finding| finding.feature)
        .collect();
    assert_eq!(
        found,
        [
            "javascript.builtins.RegExp.sticky",
            "javascript.builtins.RegExp.unicodeSets"
        ]
    );
}
