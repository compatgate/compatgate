use compatgate::allow::AllowList;
use compatgate::check;
use compatgate::targets::Targets;

const QUERY: &str = "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115";

fn features(source: &str) -> Vec<&'static str> {
    features_for(QUERY, source)
}

fn features_for(query: &str, source: &str) -> Vec<&'static str> {
    features_in(query, source, "a.js")
}

fn features_in(query: &str, source: &str, filename: &str) -> Vec<&'static str> {
    let targets = Targets::resolve(query).unwrap();
    check(source, filename, &targets, &AllowList::empty())
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

#[test]
fn optional_chaining_on_the_member_checks_it() {
    assert!(features("navigator.userAgentData?.brands;").is_empty());
    assert!(features("navigator.userAgentData?.getHighEntropyValues(['platform']);").is_empty());
    assert!(features("if (navigator.userAgentData?.mobile) {}").is_empty());
    // The optional access comes after `brands` is read from `userAgentData`, which throws when it is missing.
    assert_eq!(
        features("navigator.userAgentData.brands?.length;"),
        ["api.Navigator.userAgentData"]
    );
}

#[test]
fn a_loose_comparison_with_null_is_a_check() {
    assert!(features("if (window.structuredClone != null) structuredClone(1);").is_empty());
    assert!(features("if (null != window.structuredClone) structuredClone(1);").is_empty());
    assert!(features("function f() { if (window.structuredClone == null) return; structuredClone(1); }").is_empty());
}

#[test]
fn an_optional_chain_compared_with_undefined_is_a_check() {
    assert!(features("if (window?.structuredClone !== undefined) structuredClone(1);").is_empty());
    assert!(features("if (navigator?.userActivation != null) navigator.userActivation.isActive;").is_empty());
    assert!(features("function f() { if (window?.structuredClone == null) return; structuredClone(1); }").is_empty());
}

#[test]
fn an_optional_chain_does_not_protect_code_outside_it() {
    // The parentheses end the chain: `.length` reads from `undefined` and throws.
    assert_eq!(features("(window?.structuredClone).length;"), ["api.structuredClone"]);
    // The optional call checks `a`, not its argument.
    assert_eq!(features("a?.(window.structuredClone(1));"), ["api.structuredClone"]);
}

#[test]
fn a_strict_comparison_with_null_is_not_a_check() {
    // `undefined !== null`, so the call still runs in browsers without `structuredClone`.
    let targets = Targets::resolve(QUERY).unwrap();
    let source = "if (window.structuredClone !== null) structuredClone(1);";
    let call = source.find("structuredClone(1)").unwrap() as u32;
    let findings = check(source, "a.js", &targets, &AllowList::empty()).unwrap().findings;
    assert!(
        findings
            .iter()
            .any(|finding| finding.feature == "api.structuredClone" && finding.start.column == call),
        "{findings:?}"
    );
}

#[test]
fn optional_chaining_on_the_object_passes_the_tested_value() {
    assert!(features("if (navigator?.userActivation) {}").is_empty());
    assert!(features("if (!navigator?.userActivation) {} else { navigator.userActivation.isActive; }").is_empty());
    assert!(features("navigator?.userActivation || y;").is_empty());
    assert!(features("if (window?.structuredClone) structuredClone(1);").is_empty());
}

#[test]
fn a_member_called_through_a_wrapper_is_a_call() {
    assert!(features("try { (0, window.structuredClone)(1); } catch (e) {}").is_empty());
    assert!(features("(0, window.structuredClone)?.(1);").is_empty());
    assert!(
        features_in(
            QUERY,
            "try { (window.structuredClone as any)(1); } catch (e) {}",
            "a.ts"
        )
        .is_empty()
    );
    assert_eq!(features("(0, structuredClone)?.(1);"), ["api.structuredClone"]);
}

#[test]
fn a_member_called_through_an_optional_chain_is_a_call() {
    assert!(features("x = (window?.structuredClone)?.(1);").is_empty());
    assert!(features("x = (0, window?.structuredClone)?.(1);").is_empty());
    assert!(features("try { (window?.structuredClone)(1); } catch (e) {}").is_empty());
    assert_eq!(
        features("try { window?.structuredClone; } catch (e) {}"),
        ["api.structuredClone"]
    );
}

#[test]
fn a_check_on_a_local_object_does_not_guard_the_global() {
    assert_eq!(
        features("const Intl = { Segmenter: 1 }; if ('Segmenter' in Intl) new globalThis.Intl.Segmenter();"),
        ["javascript.builtins.Intl.Segmenter"]
    );
    assert_eq!(
        features("const window = {}; if (window.structuredClone) structuredClone(1);"),
        ["api.structuredClone"]
    );
    // A method key has no object, so a check on a local object still guards the method.
    assert!(features("const list = []; if (list.toSorted) list.toSorted();").is_empty());
}

#[test]
fn a_member_read_in_the_left_operand_is_guarded_in_a_value_position() {
    // Reading a member returns `undefined` when the feature is missing; it does not throw.
    assert!(features("const ua = navigator.userAgentData || null;").is_empty());
}

#[test]
fn a_member_read_used_only_as_a_boolean_is_a_check() {
    assert!(features("const ok = typeof navigator !== 'undefined' && navigator.share;").is_empty());
    assert!(features("const ok = Boolean(window.navigator?.share);").is_empty());
    assert!(features("const ok = !!navigator.share;").is_empty());
    assert!(features("function f(a) { return a || navigator.share; }").is_empty());
    assert!(features("const ok = navigator.share ? 1 : 0;").is_empty());
    assert!(features("const ok = navigator.share !== undefined;").is_empty());
    assert!(features("const ok = (navigator.share) ?? null;").is_empty());
    // The call is protected by the left operand, as before.
    assert!(features("navigator.share && navigator.share({ url });").is_empty());
}

#[test]
fn the_last_expression_of_a_sequence_is_tested_as_the_sequence() {
    // Coverage instrumentation wraps operands in sequences: `(cov().b[1][1]++, navigator.share)`.
    assert!(features("if ((c++, navigator.share)) navigator.share(d);").is_empty());
    assert!(features("const ok = typeof navigator !== 'undefined' && (c++, navigator.share);").is_empty());
    assert!(features("const ok = Boolean((c++, window.navigator?.share));").is_empty());
    assert!(features("function f() { if (!(c++, navigator.share)) return; navigator.share(d); }").is_empty());
    // The output of swc-plugin-coverage-instrument 0.0.33 for a guarded call.
    let instrumented = "function share(d) {
    cov_12343553659005210970().f[0]++;
    cov_12343553659005210970().s[0]++;
    if ((cov_12343553659005210970().b[1][0]++, typeof navigator !== 'undefined') && (cov_12343553659005210970().b[1][1]++, navigator.share)) {
        cov_12343553659005210970().b[0][0]++;
        cov_12343553659005210970().s[1]++;
        navigator.share(d);
    } else {
        cov_12343553659005210970().b[0][1]++;
    }
}";
    assert!(features(instrumented).is_empty());
}

#[test]
fn other_expressions_of_a_sequence_are_not_tested() {
    // The value of the sequence is `c`: the read is a use, and it does not guard the call.
    assert_eq!(
        features("if ((navigator.share, c)) navigator.share(d);"),
        ["api.Navigator.share"; 2]
    );
}

#[test]
fn a_call_to_the_global_boolean_is_tested_as_its_argument() {
    assert!(features("if (Boolean(navigator.share)) navigator.share(d);").is_empty());
    assert!(features("function f() { if (!Boolean(navigator.share)) return; navigator.share(d); }").is_empty());
    // A local `Boolean` may return anything.
    assert_eq!(
        features("const Boolean = (x) => true; if (Boolean(navigator.share)) navigator.share(d);"),
        ["api.Navigator.share"; 2]
    );
}

#[test]
fn a_member_read_whose_value_goes_further_is_a_use() {
    let feature = "api.Navigator.share";
    assert_eq!(features("const f = navigator.share;"), [feature]);
    // `Boolean` reads `length` from the member, which throws when it is missing.
    assert_eq!(features("Boolean(navigator.share.length);"), [feature]);
    // A local `Boolean` may use the value in any way.
    assert_eq!(
        features("const Boolean = (x) => x; Boolean(navigator.share);"),
        [feature]
    );
    assert_eq!(features("Boolean(...navigator.share);"), [feature]);
    // A bare global throws `ReferenceError` when it is missing.
    assert_eq!(features("!structuredClone;"), ["api.structuredClone"]);
}

#[test]
fn a_logical_whose_value_is_called_or_dereferenced_is_a_use() {
    // A missing member reaches the call through a right operand or through the left operand of `&&`.
    let feature = ["api.Navigator.share"];
    assert_eq!(features("(a || navigator.share)(x);"), feature);
    assert_eq!(features("(a ?? navigator.share)(x);"), feature);
    assert_eq!(features("(a && navigator.share)(x);"), feature);
    assert_eq!(features("(navigator.share && a)(x);"), feature);
    assert_eq!(features("new (a || navigator.share)(x);"), feature);
    assert_eq!(features("(a || navigator.share).call(n, x);"), feature);
    assert_eq!(features("(a || navigator.share).apply(n, []);"), feature);
    assert_eq!(features("((b && navigator.share) && a)(x);"), feature);
    assert_eq!(features("(a || navigator.share)`x`;"), feature);
    assert_eq!(features("[...(a || navigator.share)];"), feature);
    assert_eq!(features("if ((a || navigator.share)(x)) {}"), feature);
}

#[test]
fn a_logical_that_replaces_a_missing_member_is_a_check() {
    // The left operand of `||` and `??` gives way to the right one before the call or the member access.
    assert!(features("(navigator.share || a)(x);").is_empty());
    assert!(features("(navigator.share ?? fallback)(x);").is_empty());
    assert!(features("(navigator.share || a).bind(n);").is_empty());
    assert!(features("((b || navigator.share) || a)(x);").is_empty());
    // An optional call does nothing with `undefined`.
    assert!(features("(a || navigator.share)?.(x);").is_empty());
    // The inner logical is the operand of `!`: its value is tested, not called.
    assert!(features("(!(a || navigator.share) || b)(x);").is_empty());
}

#[test]
fn a_logical_whose_value_is_destructured_extended_or_delegated_is_a_use() {
    // Destructuring, `extends`, `yield*` and a call through a sequence throw on `undefined`.
    let feature = ["api.Navigator.share"];
    assert_eq!(features("({ x } = a || navigator.share);"), feature);
    assert_eq!(features("[x] = a || navigator.share;"), feature);
    assert_eq!(features("function g({ x } = a || navigator.share) {}"), feature);
    assert_eq!(features("function g([x] = a || navigator.share) {}"), feature);
    assert_eq!(features("const { y: { x } = a || navigator.share } = o;"), feature);
    assert_eq!(features("({ y: { x } = a || navigator.share } = o);"), feature);
    assert_eq!(features("class C extends (a || navigator.share) {}"), feature);
    assert_eq!(features("function* g() { yield* (a || navigator.share); }"), feature);
    assert_eq!(features("(0, a || navigator.share)(x);"), feature);
    assert_eq!(features("f(...(a || navigator.share));"), feature);
    assert_eq!(features("new F(...(a || navigator.share));"), feature);
}

#[test]
fn a_logical_whose_value_is_stored_is_a_check() {
    // These forms keep `undefined` without reading from it.
    assert!(features("x = a || navigator.share;").is_empty());
    assert!(features("function g(x = a || navigator.share) {}").is_empty());
    assert!(features("const { y = a || navigator.share } = o;").is_empty());
    assert!(features("({ y = a || navigator.share } = o);").is_empty());
    assert!(features("o = { m: a || navigator.share };").is_empty());
    assert!(features("function* g() { yield a || navigator.share; }").is_empty());
    assert!(features("(a || navigator.share, 0)(x);").is_empty());
    assert!(features("x = (0, a || navigator.share);").is_empty());
    // Object spread skips `undefined`.
    assert!(features("x = { ...(a || navigator.share) };").is_empty());
}

#[test]
fn a_long_and_chain_that_is_called_is_checked_in_linear_time() {
    // Every use climbs the whole chain unless the verdict of each logical is kept. Debug build, 40 000
    // terms: 0.28 s with the kept verdicts, 23.7 s without them (0.41 s for 5000 terms, so a smaller
    // chain does not catch the regression).
    let terms = vec!["navigator.share"; 40_000];
    let (findings, elapsed) = time_check(format!("({})(y);", terms.join(" &&\n")), "a.js");
    // The first read is called when it is missing. The others run only after it is present.
    assert_eq!(findings, 1);
    assert!(elapsed < BUDGET, "{elapsed:?}");
}

#[test]
fn a_long_or_chain_that_ends_with_a_member_read_is_checked_in_linear_time() {
    let mut terms: Vec<String> = (0..5000).map(|i| format!("a{i}")).collect();
    terms.push("navigator.share".to_string());
    let (findings, elapsed) = time_check(format!("x = {};", terms.join(" ||\n")), "a.js");
    assert_eq!(findings, 0);
    assert!(elapsed < BUDGET, "{elapsed:?}");
}

#[test]
fn checks_for_a_missing_feature_guard_the_code_after_an_early_exit() {
    assert!(features("function f() { if (typeof structuredClone > \"u\") return; structuredClone(1); }").is_empty());
    assert!(features("function f() { if (\"u\" < typeof structuredClone) return; structuredClone(1); }").is_empty());
    assert!(
        features("function f() { if (window.structuredClone === undefined) return; structuredClone(1); }").is_empty()
    );
    assert!(features("function f() { if (window.structuredClone == null) return; structuredClone(1); }").is_empty());
}

#[test]
fn a_shadowed_undefined_is_not_a_check() {
    assert_eq!(
        features("function f(undefined) { if (window.structuredClone !== undefined) structuredClone(1); }"),
        ["api.structuredClone"]
    );
}

#[test]
fn typeof_of_a_call_is_a_use() {
    assert_eq!(features("typeof structuredClone(x);"), ["api.structuredClone"]);
}

// Guard detection used to walk whole subtrees and whole statement lists for every use, so large
// generated files in node_modules took minutes. The budget is generous for a debug build on a slow
// machine: before the fix, the first two tests needed 42 s and 93 s. A failure means the cost became
// super-linear again.
const BUDGET: std::time::Duration = std::time::Duration::from_secs(10);

fn time_check(source: String, filename: &'static str) -> (usize, std::time::Duration) {
    // oxc visits the AST recursively, and a debug build overflows the 2 MiB stack of a test thread
    // on a chain of 2000 terms. A release build on a main thread does not.
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let targets = Targets::resolve(QUERY).unwrap();
            let start = std::time::Instant::now();
            let findings = check(&source, filename, &targets, &AllowList::empty())
                .unwrap()
                .findings
                .len();
            (findings, start.elapsed())
        })
        .unwrap()
        .join()
        .unwrap()
}

#[test]
fn a_long_logical_chain_of_member_reads_is_checked_in_linear_time() {
    let terms: Vec<String> = (0..2000).map(|i| format!("navigator.userActivation.a{i}")).collect();
    // One term per line: on a single line, converting 4000 offsets to UTF-16 columns would dominate.
    let (findings, elapsed) = time_check(format!("x = {};", terms.join(" ||\n")), "a.js");
    assert_eq!(findings, 2000);
    assert!(elapsed < BUDGET, "{elapsed:?}");
}

#[test]
fn many_early_exits_are_checked_in_linear_time() {
    let mut source = String::new();
    for i in 0..20_000 {
        source.push_str(&format!(
            "if (!a{i}) return;\nObject.assign(t, s{i});\nstructuredClone(v{i});\n"
        ));
    }
    let (findings, elapsed) = time_check(source, "a.cjs");
    assert_eq!(findings, 20_000);
    assert!(elapsed < BUDGET, "{elapsed:?}");
}

// Debug build: the quadratic code needed 14.1 s for 9000 terms (11.2 s for 8000, 17.4 s for 10 000).
// The linear guards needed 2.8 s, nearly all of it in the syntax detector, which walked the
// ancestors of every node. Since that walk became one pass over the nodes, the test needs 0.05 s.
#[test]
fn a_long_and_chain_of_unsupported_reads_is_checked_in_linear_time() {
    let terms = vec!["window.structuredClone"; 9000];
    let (findings, elapsed) = time_check(format!("x = {};", terms.join(" &&\n")), "a.js");
    assert_eq!(findings, 0);
    assert!(elapsed < BUDGET, "{elapsed:?}");
}
