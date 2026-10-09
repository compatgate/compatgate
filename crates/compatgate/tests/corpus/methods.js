// Calls of prototype methods by name. Snippets that declare a member name or bind a module at the top
// level are in `methods/`.

// typeof_of_a_method_call_is_a_use: `typeof` protects a read of the method, not a call of it.
typeof arr.toSorted(); //~ javascript.builtins.Array.toSorted heuristic

// a_unique_method_name_is_a_heuristic_finding
arr.toSorted(); //~ javascript.builtins.Array.toSorted heuristic
other.union(set); //~ javascript.builtins.Set.union heuristic

// a_name_that_a_supported_member_also_has_is_skipped
[1].map(x => x).filter(Boolean).at(-1); //~ none

// methods_of_imported_modules_are_skipped (the imports are in `methods/`)
{
  const R = require('ramda'); //~ none
  R.take(1, list); //~ none
}
R.take(1, list); //~ javascript.builtins.Iterator.take heuristic

// static_methods_are_not_reported_as_prototype_methods
Object.groupBy([], f); //~ javascript.builtins.Object.groupBy exact
Promise.withResolvers(); //~ javascript.builtins.Promise.withResolvers exact

// methods_of_required_or_imported_modules_in_transpiled_code_are_skipped
require('ramda').take(1, xs); //~ none
{
  const _ = require('lodash').default; //~ none
  _.union(a, b); //~ none
}
{
  const lodash_1 = __importDefault(require("lodash")); //~ none
  lodash_1.default.union(a, b); //~ none
}
{
  var _lodash = _interopRequireDefault(require("lodash")); //~ none
  _lodash.default.union(a, b); //~ none
}
{ async function f() { const m = await import('ramda'); m.take(1, xs); } } //~ none
{
  const { fp } = require('lodash'); //~ none
  fp.union(a, b); //~ none
}

// a_single_argument_call_that_wraps_no_module_is_not_skipped
{
  const x = foo(bar); //~ none
  x.take(1); //~ javascript.builtins.Iterator.take heuristic
}

// a_local_function_named_require_is_not_a_module_loader (the function declaration is in `methods/`)
{ const require = () => ({}); const R = require('x'); R.take(1); } //~ javascript.builtins.Iterator.take heuristic

// a_parameter_named_require_is_a_module_loader: Browserify and AMD wrap a module in a function that
// receives `require`.
(function (require) { const R = require('ramda'); R.take(1); })(r); //~ none
define(['require'], require => { require('ramda').take(1); }); //~ none

// a_method_named_by_a_string_key_is_a_use: the guards name it the same way.
arr['toSorted'](); //~ javascript.builtins.Array.toSorted heuristic
other["union"](set); //~ javascript.builtins.Set.union heuristic
arr[name](); arr[`toSorted`](); //~ none
if (arr['toSorted']) arr['toSorted'](); //~ none
if (arr.toSorted) arr['toSorted'](); //~ none

// call_and_apply_of_a_method_are_uses
arr.toSorted.call(other); //~ javascript.builtins.Array.toSorted heuristic
arr.toSorted.apply(other, []); //~ javascript.builtins.Array.toSorted heuristic
arr['toSorted'].call(other); //~ javascript.builtins.Array.toSorted heuristic
if (arr.toSorted) arr.toSorted.call(other); //~ none
arr.toSorted?.call(other); //~ none

// a_method_called_through_a_sequence_is_a_use
(0, arr.toSorted)(); //~ javascript.builtins.Array.toSorted heuristic
(0, arr.toSorted)?.(); //~ none

// a_method_read_into_a_name_is_a_use_where_the_name_is_used
{ const f = arr.toSorted; f.call(arr); } //~ javascript.builtins.Array.toSorted heuristic
{ const f = arr.toSorted; } //~ none
{ const f = arr.toSorted; if (f) f.call(arr); } //~ none
{ const f = arr['toSorted']; f.call(arr); } //~ javascript.builtins.Array.toSorted heuristic
{ const f = arr.toSorted; const g = f; g(); } //~ javascript.builtins.Array.toSorted heuristic
{ let f; f = arr.toSorted; f.apply(arr, []); } //~ javascript.builtins.Array.toSorted heuristic
{ let f = arr.toSorted; f = g; f(); } //~ none

// a_method_read_that_is_never_called_is_no_heuristic_use: many objects have data properties with
// method names, such as `compilation.chunks` of webpack and `options.windows` of picomatch.
for (const chunk of compilation.chunks) {} compilation.chunks.delete(c); c.chunks[0]; //~ none
f(options.windows); list.then(arr.toSorted); { const w = options.windows; f(w); } //~ none
f([3, 1].toSorted); //~ javascript.builtins.Array.toSorted exact

// a_call_shape_that_the_detector_does_not_follow_is_no_heuristic_use
(c ? arr.toSorted : other.toSorted)(); (arr.toSorted || f)(); arr.toSorted.bind(o)(); //~ none
new arr.toSorted(); arr.toSorted`x`; //~ none

// a_destructured_method_is_no_use: without a type a name in a pattern tells even less than a call.
{ const { toSorted } = arr; toSorted.call(arr); } //~ none

// a_method_read_by_a_check_is_no_use
if (arr.toSorted) {} //~ none
typeof arr.toSorted; arr.toSorted === undefined; 'toSorted' in arr; //~ none

// a_literal_receiver_has_a_known_type: the finding names the method of the type and is exact.
[3, 1]['toSorted'](); //~ javascript.builtins.Array.toSorted exact
'abc'.isWellFormed(); //~ javascript.builtins.String.isWellFormed exact
`abc`.toWellFormed(); //~ javascript.builtins.String.toWellFormed exact
new Set([1]).union(set); //~ javascript.builtins.Set.union exact
(new Set).isSubsetOf(set); //~ javascript.builtins.Set.isSubsetOf exact
new Map().getOrInsert(1, 2); //~ javascript.builtins.Map.getOrInsert exact
if ([].toSorted) [3, 1].toSorted(); //~ none

// a_literal_receiver_without_the_method_is_no_finding
'abc'.toSorted(); [].isWellFormed(); new Set().toSorted(); new Map().union(set); //~ none
(1).take(1); /a/.union(set); `a${b}`.toArray(); //~ none
1n.toSorted(); true.toSorted(); false.union(set); (1n).take(1); //~ none

// a_shadowed_constructor_gives_no_literal_type
{ const Set = Array; new Set().toSorted(); } //~ javascript.builtins.Array.toSorted heuristic
