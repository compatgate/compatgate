// Checks that guard a use: `in`, `typeof`, truthiness, comparisons, branches and early exits.

// in_typeof_and_truthiness_checks_guard_the_branch
if ('Segmenter' in Intl) new Intl.Segmenter(); //~ none
typeof structuredClone === 'function' ? structuredClone(x) : clone(x); //~ none
window.structuredClone && structuredClone(1); //~ none
if (navigator.userActivation) navigator.userActivation.isActive; //~ none

// a_negative_check_guards_the_else_branch_and_the_code_after_an_early_exit
if (!navigator.userActivation) {} else { navigator.userActivation.isActive; } //~ none
{ function f() { if (!window.structuredClone) return; structuredClone(1); } } //~ none
{ function f() { if (typeof structuredClone === 'undefined') { throw e; } structuredClone(1); } } //~ none

// a_check_guards_a_nested_function
if (typeof structuredClone !== 'undefined') { setTimeout(() => structuredClone(1)); } //~ none

// a_check_of_another_feature_does_not_guard
if (window.structuredClone) new Intl.Segmenter(); //~ javascript.builtins.Intl.Segmenter exact

// a_bare_global_in_a_test_is_a_use_because_it_throws_when_missing
if (structuredClone) {} //~ api.structuredClone exact

// syntax_in_a_test_is_still_reported
if (/(?<=a)/.test(s)) {} //~ javascript.regular_expressions.lookbehind_assertion exact

// minified_checks_are_recognized
"Segmenter"in Intl&&new Intl.Segmenter; //~ none
0,structuredClone(x); //~ api.structuredClone exact

// a_member_read_guards_only_when_it_is_the_tested_operand
if (navigator.userActivation.isActive) {} //~ api.Navigator.userActivation exact
'isActive' in navigator.userActivation; //~ api.Navigator.userActivation exact
if (a && navigator.userActivation.isActive) {} //~ api.Navigator.userActivation exact
typeof navigator.userActivation.isActive; //~ api.Navigator.userActivation exact
if (navigator.userActivation && navigator.userActivation.isActive) {} //~ none

// negative_branches_and_minified_forms
if (window.structuredClone) {} else { structuredClone(1); } //~ api.structuredClone exact
!window.structuredClone || structuredClone(1); //~ none
typeof structuredClone<"u"&&structuredClone(1); //~ none
if (void 0 !== window.structuredClone) structuredClone(1); //~ none
if (window.structuredClone !== undefined) structuredClone(1); //~ none

// a_loose_comparison_with_null_is_a_check
if (window.structuredClone != null) structuredClone(1); //~ none
if (null != window.structuredClone) structuredClone(1); //~ none
{ function f() { if (window.structuredClone == null) return; structuredClone(1); } } //~ none

// an_optional_chain_compared_with_undefined_is_a_check
if (window?.structuredClone !== undefined) structuredClone(1); //~ none
if (navigator?.userActivation != null) navigator.userActivation.isActive; //~ none
{ function f() { if (window?.structuredClone == null) return; structuredClone(1); } } //~ none

// a_strict_comparison_with_null_is_not_a_check: `undefined !== null`, so the call still runs in
// browsers without `structuredClone`.
if (window.structuredClone !== null) //~ none
  structuredClone(1); //~ api.structuredClone exact

// optional_chaining_on_the_object_passes_the_tested_value
if (navigator?.userActivation) {} //~ none
if (!navigator?.userActivation) {} else { navigator.userActivation.isActive; } //~ none
navigator?.userActivation || y; //~ none
if (window?.structuredClone) structuredClone(1); //~ none

// a_check_on_a_local_object_does_not_guard_the_global
{ const Intl = { Segmenter: 1 }; if ('Segmenter' in Intl) new globalThis.Intl.Segmenter(); } //~ javascript.builtins.Intl.Segmenter exact
{ const window = {}; if (window.structuredClone) structuredClone(1); } //~ api.structuredClone exact
// A method key has no object, so a check on a local object still guards the method.
{ const list = []; if (list.toSorted) list.toSorted(); } //~ none

// a_member_read_in_the_left_operand_is_guarded_in_a_value_position: reading a member returns
// `undefined` when the feature is missing; it does not throw.
{ const ua = navigator.userAgentData || null; } //~ none

// a_member_read_used_only_as_a_boolean_is_a_check
{ const ok = typeof navigator !== 'undefined' && navigator.share; } //~ none
{ const ok = Boolean(window.navigator?.share); } //~ none
{ const ok = !!navigator.share; } //~ none
{ function f(a) { return a || navigator.share; } } //~ none
{ const ok = navigator.share ? 1 : 0; } //~ none
{ const ok = navigator.share !== undefined; } //~ none
{ const ok = (navigator.share) ?? null; } //~ none
// The call is protected by the left operand.
navigator.share && navigator.share({ url }); //~ none

// a_call_to_the_global_boolean_is_tested_as_its_argument
if (Boolean(navigator.share)) navigator.share(d); //~ none
{ function f() { if (!Boolean(navigator.share)) return; navigator.share(d); } } //~ none
// A local `Boolean` may return anything.
{ const Boolean = (x) => true; if (Boolean(navigator.share)) navigator.share(d); } //~ @44 api.Navigator.share exact; @62 api.Navigator.share exact

// a_member_read_whose_value_goes_further_is_a_use
{ const f = navigator.share; g(f); } //~ api.Navigator.share exact
// `Boolean` reads `length` from the member, which throws when it is missing.
Boolean(navigator.share.length); //~ api.Navigator.share exact
// A local `Boolean` may use the value in any way.
{ const Boolean = (x) => x; Boolean(navigator.share); } //~ api.Navigator.share exact
Boolean(...navigator.share); //~ api.Navigator.share exact
// A bare global throws `ReferenceError` when it is missing.
!structuredClone; //~ api.structuredClone exact

// checks_for_a_missing_feature_guard_the_code_after_an_early_exit
{ function f() { if (typeof structuredClone > "u") return; structuredClone(1); } } //~ none
{ function f() { if ("u" < typeof structuredClone) return; structuredClone(1); } } //~ none
{ function f() { if (window.structuredClone === undefined) return; structuredClone(1); } } //~ none
{ function f() { if (window.structuredClone == null) return; structuredClone(1); } } //~ none

// a_shadowed_undefined_is_not_a_check
{ function f(undefined) { if (window.structuredClone !== undefined) structuredClone(1); } } //~ api.structuredClone exact

// typeof_of_a_call_is_a_use
typeof structuredClone(x); //~ api.structuredClone exact
