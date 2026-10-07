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
fn finds_a_member_of_a_global_builtin() {
    assert_eq!(
        features("new Intl.Segmenter('en');", "a.js"),
        ["javascript.builtins.Intl.Segmenter"]
    );
    assert_eq!(
        features("Object.groupBy([], x => x);", "a.js"),
        ["javascript.builtins.Object.groupBy"]
    );
}

#[test]
fn ignores_features_present_in_all_targets() {
    assert!(
        features(
            "[1].at(-1); new Map(); Object.keys({}); fetch('/'); Intl.DateTimeFormat;",
            "a.js"
        )
        .is_empty()
    );
}

#[test]
fn ignores_unknown_globals() {
    assert!(features("__DEV__ && process.env.NODE_ENV;", "a.js").is_empty());
}

#[test]
fn ignores_a_local_binding_with_a_global_name() {
    assert!(
        features(
            "function f() { const structuredClone = x => x; return structuredClone(1); }",
            "a.js"
        )
        .is_empty()
    );
}

#[test]
fn ignores_typescript_type_references() {
    assert!(features("let s: Intl.Segmenter | undefined;\nlet o: ResizeObserver;\n", "a.ts").is_empty());
}

#[test]
fn reports_partial_support_with_partial_confidence() {
    let targets = Targets::resolve("Chrome >= 97").unwrap();
    let output = check("new BarcodeDetector();", "a.js", &targets, &AllowList::empty()).unwrap();
    assert_eq!(output.findings.len(), 1);
    assert_eq!(output.findings[0].confidence, Confidence::Partial);
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
fn parses_jsx_in_plain_javascript_files() {
    assert_eq!(
        features("const a = <div />;\nstructuredClone(a);\n", "a.js"),
        ["api.structuredClone"]
    );
    assert_eq!(
        features("export const a = <div />;\nstructuredClone(a);\n", "a.mjs"),
        ["api.structuredClone"]
    );
}

#[test]
fn uppercase_extension_is_accepted() {
    assert_eq!(features("structuredClone(1);", "A.JS"), ["api.structuredClone"]);
}

#[test]
fn top_level_return_in_commonjs_is_accepted() {
    assert_eq!(
        features(
            "if (typeof module === 'undefined') return;\nstructuredClone(1);\n",
            "a.js"
        ),
        ["api.structuredClone"]
    );
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
