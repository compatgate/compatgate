//! Tests of the API: positions, gaps and notes, `allow`, the order of findings, file names and errors.
//! The findings of snippets are in `tests/corpus`.

use compatgate::allow::{AllowEntry, AllowList};
use compatgate::position::Position;
use compatgate::targets::Targets;
use compatgate::{Confidence, Error, Kind, check};

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
    assert_eq!(finding.start, Position { line: 2, column: 0 });
    assert_eq!(finding.end, Position { line: 2, column: 15 });
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

#[test]
fn syntax_error_is_a_parse_error_with_the_filename() {
    let targets = Targets::resolve(QUERY).unwrap();
    let error = check("const = ;", "broken.js", &targets, &AllowList::empty()).unwrap_err();
    assert!(
        matches!(&error, Error::Parse(text) if text.contains("broken.js")),
        "{error}"
    );
}

#[test]
fn unknown_extension_is_a_parse_error() {
    let targets = Targets::resolve(QUERY).unwrap();
    let error = check("<template></template>", "a.vue", &targets, &AllowList::empty()).unwrap_err();
    assert!(
        matches!(&error, Error::Parse(text) if text.contains("a.vue")),
        "{error}"
    );
}

#[test]
fn uppercase_extension_is_accepted() {
    assert_eq!(features("structuredClone(1);", "A.JS"), ["api.structuredClone"]);
}

#[test]
fn parse_error_names_line_and_column() {
    let targets = Targets::resolve(QUERY).unwrap();
    let error = check("const a = 1;\nconst = ;", "broken.js", &targets, &AllowList::empty()).unwrap_err();
    assert!(
        matches!(&error, Error::Parse(text) if text.contains("broken.js:2:")),
        "{error}"
    );
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
