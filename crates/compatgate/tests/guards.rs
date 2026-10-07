use compatgate::allow::AllowList;
use compatgate::check;
use compatgate::targets::Targets;

const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

fn features(source: &str) -> Vec<&'static str> {
    features_for(QUERY, source)
}

fn features_for(query: &str, source: &str) -> Vec<&'static str> {
    let targets = Targets::resolve(query).unwrap();
    check(source, "a.js", &targets, &AllowList::empty())
        .unwrap()
        .findings
        .into_iter()
        .map(|finding| finding.feature)
        .collect()
}

#[test]
fn in_typeof_and_truthiness_checks_guard_the_branch() {
    assert!(features("if ('Segmenter' in Intl) new Intl.Segmenter();").is_empty());
    assert!(features("typeof structuredClone === 'function' ? structuredClone(x) : clone(x);").is_empty());
    assert!(features("window.structuredClone && structuredClone(1);").is_empty());
    assert!(features("if (navigator.userActivation) navigator.userActivation.isActive;").is_empty());
}

#[test]
fn a_negative_check_guards_the_else_branch_and_the_code_after_an_early_exit() {
    assert!(features("if (!navigator.userActivation) {} else { navigator.userActivation.isActive; }").is_empty());
    assert!(features("function f() { if (!window.structuredClone) return; structuredClone(1); }").is_empty());
    assert!(
        features("function f() { if (typeof structuredClone === 'undefined') { throw e; } structuredClone(1); }")
            .is_empty()
    );
}

#[test]
fn a_check_guards_a_nested_function() {
    assert!(
        features("if (typeof structuredClone !== 'undefined') { setTimeout(() => structuredClone(1)); }").is_empty()
    );
}

#[test]
fn a_check_of_another_feature_does_not_guard() {
    assert_eq!(
        features("if (window.structuredClone) new Intl.Segmenter();"),
        ["javascript.builtins.Intl.Segmenter"]
    );
}

#[test]
fn try_guards_calls_and_constructors_only() {
    assert!(features("try { new Intl.Segmenter(); } catch {}").is_empty());
    assert!(features("try { new RegExp('(?<=a)b'); } catch {}").is_empty());
    assert_eq!(
        features("try { /(?<=a)b/; } catch {}"),
        ["javascript.regular_expressions.lookbehind_assertion"]
    );
    assert_eq!(
        features("try { Intl.Segmenter; } catch {}"),
        ["javascript.builtins.Intl.Segmenter"]
    );
}

#[test]
fn an_optional_method_call_checks_itself() {
    assert!(features("list.toSorted?.();").is_empty());
    assert!(features("window.structuredClone?.(1);").is_empty());
    assert_eq!(features("list.toSorted();"), ["javascript.builtins.Array.toSorted"]);
}

#[test]
fn a_bare_global_in_a_test_is_a_use_because_it_throws_when_missing() {
    assert_eq!(features("if (structuredClone) {}"), ["api.structuredClone"]);
}

#[test]
fn syntax_in_a_test_is_still_reported() {
    assert_eq!(
        features("if (/(?<=a)/.test(s)) {}"),
        ["javascript.regular_expressions.lookbehind_assertion"]
    );
}

#[test]
fn a_polyfill_is_not_a_use() {
    assert!(features("if (!Array.prototype.toSorted) { Array.prototype.toSorted = function () {}; }").is_empty());
}

#[test]
fn minified_checks_are_recognized() {
    assert!(features("\"Segmenter\"in Intl&&new Intl.Segmenter;").is_empty());
    assert_eq!(features("0,structuredClone(x);"), ["api.structuredClone"]);
}

#[test]
fn a_member_read_guards_only_when_it_is_the_tested_operand() {
    let feature = "api.Navigator.userActivation";
    assert_eq!(features("if (navigator.userActivation.isActive) {}"), [feature]);
    assert_eq!(features("'isActive' in navigator.userActivation;"), [feature]);
    assert_eq!(features("if (a && navigator.userActivation.isActive) {}"), [feature]);
    assert_eq!(features("typeof navigator.userActivation.isActive;"), [feature]);
    assert!(features("if (navigator.userActivation && navigator.userActivation.isActive) {}").is_empty());
}

#[test]
fn try_guards_only_with_a_catch_and_inside_the_same_function() {
    assert_eq!(
        features("try { new Intl.Segmenter(); } finally {}"),
        ["javascript.builtins.Intl.Segmenter"]
    );
    assert_eq!(
        features("try { setTimeout(() => new Intl.Segmenter()); } catch {}"),
        ["javascript.builtins.Intl.Segmenter"]
    );
}

#[test]
fn syntax_on_a_call_is_not_protected_by_try_or_an_optional_call() {
    // The default targets support trailing commas in calls, so this test uses an old Chrome.
    // The syntax detector puts them on the call node, but a parse-time error cannot be caught.
    let old = "Chrome >= 50";
    let feature = "javascript.grammar.trailing_commas.trailing_commas_in_functions";
    assert_eq!(features_for(old, "f(a,);"), [feature]);
    assert_eq!(features_for(old, "try { f(a,); } catch (e) {}"), [feature]);
    assert!(features_for(old, "a.b?.(x,);").contains(&feature));
}

#[test]
fn negative_branches_and_minified_forms() {
    assert_eq!(
        features("if (window.structuredClone) {} else { structuredClone(1); }"),
        ["api.structuredClone"]
    );
    assert!(features("!window.structuredClone || structuredClone(1);").is_empty());
    assert!(features("typeof structuredClone<\"u\"&&structuredClone(1);").is_empty());
    assert!(features("if (void 0 !== window.structuredClone) structuredClone(1);").is_empty());
    assert!(features("if (window.structuredClone !== undefined) structuredClone(1);").is_empty());
}
