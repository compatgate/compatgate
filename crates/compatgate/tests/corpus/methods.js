// Calls of prototype methods by name. Snippets that declare a member name or bind a module at the top
// level are in `methods/`.

// typeof_of_a_method_call_is_a_use: `typeof` protects a read of the method, not a call of it.
typeof [3, 1].toSorted(); //~ javascript.builtins.Array.toSorted heuristic

// a_unique_method_name_is_a_heuristic_finding
[3, 1].toSorted(); //~ javascript.builtins.Array.toSorted heuristic
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
