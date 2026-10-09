// a_call_of_the_third_parameter_with_a_module_id_is_a_minified_webpack_require: webpack passes
// `(module, exports, __webpack_require__)` to a module function, and SWC and terser rename the third
// parameter to a short name. A production build numbers the modules, a development build names them.
(self.webpackChunk = self.webpackChunk || []).push([[1], {
  96540: (e, t, n) => {
    var o = n(96540), i = s(n(2)), a = n(3).default, c = (0, n(4)); //~ none
    o.Children.toArray(r); i.default.Children.toArray(r); a.Children.toArray(r); c.toArray(); //~ none
    n(5).Children.toArray(r); (0, n(6)).toArray(); //~ none
  },
  "./src/a.js": function (e, t, n) { var o = n("./node_modules/react/index.js"); o.Children.toArray(r); }, //~ none
}]);

// a_call_that_is_not_a_minified_webpack_require_is_not_skipped: another parameter, a local function,
// two arguments, a fraction, another argument.
function f(cb) { const x = cb(1); x.toSorted(); } //~ javascript.builtins.Array.toSorted heuristic
items.forEach(fn => fn(0).toArray()); //~ javascript.builtins.Iterator.toArray heuristic
function f2(get) { const x = get('a'); x.toArray(); } //~ javascript.builtins.Iterator.toArray heuristic
function g() { const h = (k) => k; const x = h(1); x.toArray(); } //~ javascript.builtins.Iterator.toArray heuristic
function k(e, t, n) { const x = n(1, 2); x.toArray(); } //~ javascript.builtins.Iterator.toArray heuristic
function m(e, t, n) { const x = n(1.5); x.toArray(); } //~ javascript.builtins.Iterator.toArray heuristic
function p(e, t, n) { const x = n(id); x.toArray(); } //~ javascript.builtins.Iterator.toArray heuristic
