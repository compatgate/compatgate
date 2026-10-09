// Aliases. A variable that always holds the value of an expression, when it holds a value at all, is an
// alias of the expression: a `const` or a variable without writes, and a `var` or `let` without an
// initializer that the code writes once with `y = X`. A raw value that escapes into an alias goes on from
// every read of the alias, and a check of the alias is a check of the expression.

// a_const_alias_goes_on_from_its_reads
{ const s = navigator.share; if (s) s(d); } //~ none
{ const s = navigator.share; s(d); } //~ api.Navigator.share exact
{ const s = navigator.share; typeof s === 'function' && s(d); } //~ none
{ const s = navigator.share; s && s.call(navigator, d); } //~ none
function a12() { const s = navigator.share; if (!s) return; s(d); } //~ none
// A read that passes the value on is a use where it escapes.
{ const s = navigator.share; g(s); } //~ api.Navigator.share exact
{ const s = navigator.share; if (s) g(s); } //~ none
function a13() { const s = navigator.share; return s; } //~ api.Navigator.share exact
// A dropped or tested read is no use, and an alias without reads is no use either.
{ const s = navigator.share; if (s) x(); } //~ none
{ const s = navigator.share; } //~ none
// A variable without writes is an alias too.
{ let s = navigator.share; if (s) s(d); } //~ none
function a14() { var s = navigator.share; if (s) s(d); } //~ none
// The scripts of a page share their top-level names, so another script may write a top-level `var`.
var s0 = navigator.share; if (s0) s0(d); //~ api.Navigator.share exact
// An alias of an alias.
{ const s = navigator.share; const t = s; if (t) t(d); } //~ none
{ const s = navigator.share; const t = s; t(d); } //~ api.Navigator.share exact
// An alias of the global object.
{ const g = globalThis; if (g.structuredClone) structuredClone(v); } //~ none
{ const w = window; if (w.navigator.share) navigator.share(d); } //~ none

// a_variable_with_another_write_is_no_alias
{ let s = navigator.share; s = f; if (s) s(d); } //~ api.Navigator.share exact
function a0() { var t; t = navigator.share; t = f; if (t) t(d); } //~ api.Navigator.share exact
function a1() { var t; t = f; if (t) t(d); t = navigator.share; } //~ api.Navigator.share exact
// A parameter holds the argument before its write.
function a2(t) { t = navigator.share; if (t) t(d); } //~ api.Navigator.share exact
// A loop variable holds the items of the list.
function a3(list) { for (var t of list) { if (t) t(d); } t = navigator.share; } //~ api.Navigator.share exact
// A check of a variable with another write proves nothing about the use.
function a4() { var t = navigator.share; t = f; if (t) navigator.share(d); } //~ @25 api.Navigator.share exact; @56 api.Navigator.share exact

// a_value_that_passed_a_logical_does_not_follow_its_alias
// An optional value is no finding where it escapes, so its alias is not followed: a check of the alias
// would not prove the use present.
{ const s = a || navigator.share; s(d); } //~ none
{ const s = a || navigator.share; if (s) s(d); } //~ none

// a_destructured_member_goes_on_from_the_reads_of_its_name
{ const { share } = navigator; if (share) share(d); } //~ none
{ const { share: s } = navigator; if (s) s(d); } //~ none
{ const { share } = navigator; share(d); } //~ api.Navigator.share exact
{ const { share } = window.navigator; typeof share === 'function' && share(d); } //~ none
{ const { 'share': s } = navigator; s && s(d); } //~ none
// A function parameter takes the argument first, and only a missing argument takes the default.
function a5({ share } = navigator) { if (share) share(d); } //~ api.Navigator.share exact
// A write through destructuring is no alias.
{ let s; ({ share: s } = navigator); if (s) s(d); } //~ api.Navigator.share exact

// a_temporary_variable_of_a_downleveled_optional_chain_is_an_alias
// Babel and TypeScript.
function a6(d) { var _t; return (_t = navigator.share) === null || _t === void 0 ? void 0 : _t.call(navigator, d); } //~ none
// SWC.
function a7(d) { var t; return null == (t = navigator.share) ? void 0 : t.call(navigator, d); } //~ none
async function a8() { var t; await ((null == (t = globalThis.scheduler) ? void 0 : t.yield) ? globalThis.scheduler.yield() : new Promise(r => setTimeout(r, 0))); } //~ none
function a9() { var e; return null != (e = performance.interactionCount) ? e : 0; } //~ none
// The temporary variable is declared before it is written: a read before the write is `undefined`, and
// a check of it is false there.
function a10() { var t; if (t) t(d); t = navigator.share; } //~ none
// The check of the chain is not a check of the call.
function a11(d) { var t; (null == (t = navigator.share) ? void 0 : t.call); t(d); } //~ api.Navigator.share exact

// a_variable_that_sloppy_code_may_write_otherwise_is_no_alias
// A function in a block writes the `var` of the same name where the block runs.
function a15() { var t = navigator.share; { function t() {} } if (t) navigator.share(d); } //~ @26 api.Navigator.share exact; @70 api.Navigator.share exact
// `t` in the body of `with` may be a property of `o`.
function a16(o) { var t = navigator.share; with (o) { if (t) navigator.share(d); } } //~ @27 api.Navigator.share exact; @62 api.Navigator.share exact
// A direct `eval` may write `t`.
function a17() { var t = navigator.share; eval('t = f'); if (t) navigator.share(d); } //~ @26 api.Navigator.share exact; @65 api.Navigator.share exact
// Nothing writes a top-level `const` of a script, so it stays an alias; a top-level `let` does not.
const s5 = navigator.share; if (s5) s5(d); //~ none
let s6 = navigator.share; if (s6) s6(d); //~ api.Navigator.share exact
