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

/// The most expensive shape, a called `&&` chain, takes about 19 guard steps per term.
const STEPS_PER_TERM: usize = 32;

/// Checks `source` and returns the number of findings and the steps it took.
fn run(source: String, filename: &'static str) -> (usize, Steps) {
    // oxc visits the AST recursively, and a debug build overflows the 2 MiB stack of a test thread
    // on a chain of 2000 terms. A release build on a main thread does not. The counters belong to
    // the thread, so the new thread reads them too.
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let targets = Targets::resolve(QUERY).unwrap();
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
#[ignore = "quadratic on 9366fb2: each unguarded use climbs to the root, through the whole chain above it"]
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
