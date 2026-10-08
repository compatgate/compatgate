//! Guard detection used to walk whole subtrees and whole statement lists for every use, so large
//! generated files in node_modules took minutes. These tests count the steps of guard detection on one
//! input shape at two sizes and check `steps ≤ STEPS_PER_TERM · terms` at both. A quadratic regression
//! breaks the bound already at the smaller size, on any machine.

use compatgate::allow::AllowList;
use compatgate::check;
use compatgate::counters::{self, Steps};
use compatgate::targets::Targets;

const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

/// The input sizes of every test: the second is four times the first.
const SIZES: [usize; 2] = [1000, 4000];

/// The most expensive shape, a long chain of member reads, takes 7 climb steps per term.
const STEPS_PER_TERM: usize = 16;

/// Checks `source` and returns the number of findings and the steps it took.
fn run(source: String, filename: &'static str) -> (usize, Steps) {
    run_with(source, filename, QUERY)
}

fn run_with(source: String, filename: &'static str, query: &'static str) -> (usize, Steps) {
    // oxc visits the AST recursively, and a debug build overflows the 2 MiB stack of a test thread
    // on a chain of 2000 terms. A release build on a main thread does not. The counters belong to
    // the thread, so the new thread reads them too.
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let targets = Targets::resolve(query).unwrap();
            counters::take();
            let findings = check(&source, filename, &targets, &AllowList::empty())
                .unwrap()
                .findings
                .len();
            (findings, counters::take())
        })
        .unwrap()
        .join()
        .unwrap()
}

fn assert_linear(terms: usize, steps: usize, what: &str) {
    assert!(
        steps <= STEPS_PER_TERM * terms,
        "{what}: {steps} steps for {terms} terms, {} per term",
        steps / terms
    );
}

#[test]
fn a_long_and_chain_that_is_called_is_checked_in_linear_time() {
    // Every use climbs the whole chain unless the verdict of each logical is kept.
    for terms in SIZES {
        let source = format!("({})(y);", vec!["navigator.share"; terms].join(" &&\n"));
        let (findings, steps) = run(source, "a.js");
        // The first read is called when it is missing. The others run only after it is present.
        assert_eq!(findings, 1);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

#[test]
fn a_long_or_chain_that_ends_with_a_member_read_is_checked_in_linear_time() {
    for terms in SIZES {
        let mut operands: Vec<String> = (0..terms).map(|i| format!("a{i}")).collect();
        operands.push("navigator.share".to_string());
        let (findings, steps) = run(format!("x = {};", operands.join(" ||\n")), "a.js");
        assert_eq!(findings, 0);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

fn member_reads(terms: usize) -> String {
    let operands: Vec<String> = (0..terms).map(|i| format!("navigator.userActivation.a{i}")).collect();
    // One term per line: on a single line, converting the offsets to UTF-16 columns would dominate.
    format!("x = {};", operands.join(" ||\n"))
}

#[test]
fn a_long_logical_chain_of_member_reads_is_checked_in_linear_time() {
    for terms in SIZES {
        let (findings, steps) = run(member_reads(terms), "a.js");
        assert_eq!(findings, terms);
        assert_linear(terms, steps.guards, "guards");
    }
}

#[test]
fn a_long_logical_chain_of_member_reads_climbs_in_linear_time() {
    for terms in SIZES {
        let (_, steps) = run(member_reads(terms), "a.js");
        assert_linear(terms, steps.climb, "climb");
    }
}

#[test]
fn many_early_exits_are_checked_in_linear_time() {
    for terms in SIZES {
        let mut source = String::new();
        for i in 0..terms {
            source.push_str(&format!(
                "if (!a{i}) return;\nObject.assign(t, s{i});\nstructuredClone(v{i});\n"
            ));
        }
        let (findings, steps) = run(source, "a.cjs");
        assert_eq!(findings, terms);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

#[test]
fn a_long_and_chain_of_unsupported_reads_is_checked_in_linear_time() {
    for terms in SIZES {
        let source = format!("x = {};", vec!["window.structuredClone"; terms].join(" &&\n"));
        let (findings, steps) = run(source, "a.js");
        assert_eq!(findings, 0);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

/// Old targets lack many global APIs, so each use below has a key of its own.
const OLD: &str = "Chrome >= 50";

/// `count` global APIs that `OLD` lacks: `use;` for each is a distinct unsupported use.
fn distinct_uses(count: usize) -> String {
    let targets = Targets::resolve(OLD).unwrap();
    let names: Vec<&str> = compatgate::data::feature_ids()
        .filter_map(|id| id.strip_prefix("api."))
        .filter(|name| !name.contains('.'))
        .filter(|name| {
            let feature = compatgate::data::FeatureId::find(&format!("api.{name}")).unwrap();
            !targets.is_supported(feature)
        })
        .take(count)
        .collect();
    assert_eq!(names.len(), count);
    names.iter().map(|name| format!("{name};\n")).collect()
}

#[test]
fn many_early_exits_before_many_distinct_uses_are_checked_in_linear_time() {
    // Every use asks the statements before it. Reading them again for each key was quadratic.
    for terms in SIZES {
        let uses = terms / 10;
        let mut source: String = (0..terms).map(|i| format!("if (!a{i}) return;\n")).collect();
        source.push_str(&distinct_uses(uses));
        let (findings, steps) = run_with(source, "a.cjs", OLD);
        assert_eq!(findings, uses);
        assert_linear(terms + uses, steps.climb, "climb");
        assert_linear(terms + uses, steps.guards, "guards");
    }
}

#[test]
fn a_long_and_chain_above_many_distinct_uses_is_checked_in_linear_time() {
    // Every use asks the test of the `if`. Evaluating the chain again for each key was quadratic.
    for terms in SIZES {
        let uses = terms / 10;
        let test = (0..terms).map(|i| format!("a{i}")).collect::<Vec<_>>().join(" &&\n");
        let source = format!("if ({test}) {{\n{}}}\n", distinct_uses(uses));
        let (findings, steps) = run_with(source, "a.js", OLD);
        assert_eq!(findings, uses);
        assert_linear(terms + uses, steps.climb, "climb");
        assert_linear(terms + uses, steps.guards, "guards");
    }
}

#[test]
fn deeply_nested_blocks_with_early_exits_are_checked_in_linear_time() {
    // Each block proves its own key to the code after it, and every level has a use. Copying the facts
    // of the nested blocks into each list around them grew with the depth.
    for terms in SIZES {
        let mut source = String::from("function f() {\n");
        for i in 0..terms {
            source.push_str(&format!("{{ if (!a{i}) return; structuredClone(v{i});\n"));
        }
        source.push_str(&"}".repeat(terms));
        source.push_str("\nstructuredClone(w);\n}\n");
        let (findings, steps) = run(source, "a.js");
        assert_eq!(findings, terms + 1);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

#[test]
fn many_sibling_blocks_before_uses_are_checked_in_linear_time() {
    // Each use asks every block before it in the same list. The answers of the blocks are kept as one
    // list of positions per subject; asking each block again per use was quadratic.
    for terms in SIZES {
        let source: String = (0..terms)
            .map(|i| format!("{{ if (!a{i}) return; }}\nstructuredClone(v{i});\n"))
            .collect();
        let (findings, steps) = run(source, "a.cjs");
        assert_eq!(findings, terms);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

/// Depths of nested tests. A test that is evaluated once per value at each level doubles its work per
/// level, so the smaller depth already breaks the bound, and it still ends in a moment.
const DEPTHS: [usize; 2] = [16, 64];

/// `((a ? b : c) ? b : c)` nested `depth` times: the test of each `?:` is another `?:`.
fn nested_conditional(depth: usize) -> String {
    (0..depth).fold(String::from("a"), |test, _| format!("({test} ? b : c)"))
}

#[test]
fn nested_conditional_tests_are_checked_in_linear_time() {
    for depth in DEPTHS {
        let source = format!("if ({}) structuredClone(v);\n", nested_conditional(depth));
        let (findings, steps) = run(source, "a.js");
        assert_eq!(findings, 1);
        assert_linear(depth, steps.climb, "climb");
        assert_linear(depth, steps.guards, "guards");
    }
}

#[test]
fn an_early_exit_on_nested_conditional_tests_is_checked_in_linear_time() {
    for depth in DEPTHS {
        let source = format!(
            "function f() {{ if ({}) return; structuredClone(v); }}\n",
            nested_conditional(depth)
        );
        let (findings, steps) = run(source, "a.js");
        assert_eq!(findings, 1);
        assert_linear(depth, steps.climb, "climb");
        assert_linear(depth, steps.guards, "guards");
    }
}

/// Checks that name BCD features. `OLD` supports them all, so none of them implies a feature that a
/// use lacks, and each use asks every one.
const CHECKED: [&str; 4] = [
    "window.fetch",
    "window.Promise",
    "window.requestAnimationFrame",
    "window.Map",
];

#[test]
fn many_early_exits_on_features_before_uses_are_checked_in_linear_time() {
    // Every use asks whether a feature checked before it implies its own. Scanning every checked
    // feature of the list for each use was quadratic.
    for terms in SIZES {
        let source: String = (0..terms)
            .map(|i| format!("if (!{}) return;\nnavigation.x;\n", CHECKED[i % CHECKED.len()]))
            .collect();
        let (findings, steps) = run(source, "a.cjs");
        assert_eq!(findings, terms);
        assert_linear(terms, steps.climb, "climb");
        assert_linear(terms, steps.guards, "guards");
    }
}

#[test]
fn a_long_and_chain_of_features_above_many_distinct_uses_is_checked_in_linear_time() {
    // Every use asks the chain whether a feature that it checks implies the feature of the use.
    for terms in SIZES {
        let uses = terms / 10;
        let test = (0..terms)
            .map(|i| CHECKED[i % CHECKED.len()])
            .collect::<Vec<_>>()
            .join(" &&\n");
        let source = format!("if ({test}) {{\n{}}}\n", distinct_uses(uses));
        let (findings, steps) = run_with(source, "a.js", OLD);
        assert_eq!(findings, uses);
        assert_linear(terms + uses, steps.climb, "climb");
        assert_linear(terms + uses, steps.guards, "guards");
    }
}

/// `count` checks `if (!window.<name>) return;`, each of a distinct global API.
fn distinct_checks(count: usize) -> String {
    let names: Vec<&str> = compatgate::data::feature_ids()
        .filter_map(|id| id.strip_prefix("api."))
        .filter(|name| !name.contains('.'))
        .take(count)
        .collect();
    assert_eq!(names.len(), count);
    names
        .iter()
        .map(|name| format!("if (!window.{name}) return;\n"))
        .collect()
}

#[test]
fn many_distinct_uses_before_many_early_exits_on_features_are_checked_in_linear_time() {
    // A use asks only the statements before it, and here they name no feature. Finding the checked
    // features that imply the feature of a use over the whole list cost uses × checks.
    for terms in [250, 1000] {
        let uses = terms / 4;
        let source = format!("{}{}", distinct_uses(uses), distinct_checks(terms));
        let (findings, steps) = run_with(source, "a.cjs", OLD);
        assert_eq!(findings, uses);
        assert_linear(terms + uses, steps.climb, "climb");
        assert_linear(terms + uses, steps.guards, "guards");
    }
}
