// A missing member reads as `undefined`. A logical passes it on, except the left operand of `||` and
// `??`, which the right operand replaces. The use counts where `undefined` throws.

// a_logical_whose_value_is_called_or_dereferenced_is_a_use: a missing member reaches the call through a
// right operand or through the left operand of `&&`.
(a || navigator.share)(x); //~ api.Navigator.share exact
(a ?? navigator.share)(x); //~ api.Navigator.share exact
(a && navigator.share)(x); //~ api.Navigator.share exact
(navigator.share && a)(x); //~ api.Navigator.share exact
new (a || navigator.share)(x); //~ api.Navigator.share exact
(a || navigator.share).call(n, x); //~ api.Navigator.share exact
(a || navigator.share).apply(n, []); //~ api.Navigator.share exact
((b && navigator.share) && a)(x); //~ api.Navigator.share exact
(a || navigator.share)`x`; //~ api.Navigator.share exact
[...(a || navigator.share)]; //~ api.Navigator.share exact
if ((a || navigator.share)(x)) {} //~ api.Navigator.share exact

// a_logical_that_replaces_a_missing_member_is_a_check: the left operand of `||` and `??` gives way to
// the right one before the call or the member access.
(navigator.share || a)(x); //~ none
(navigator.share ?? fallback)(x); //~ none
(navigator.share || a).bind(n); //~ none
((b || navigator.share) || a)(x); //~ none
// An optional call does nothing with `undefined`.
(a || navigator.share)?.(x); //~ none
// The inner logical is the operand of `!`: its value is tested, not called.
(!(a || navigator.share) || b)(x); //~ none

// a_logical_whose_value_is_destructured_extended_or_delegated_is_a_use: destructuring, `extends`,
// `yield*` and a call through a sequence throw on `undefined`.
({ x } = a || navigator.share); //~ api.Navigator.share exact
[x] = a || navigator.share; //~ api.Navigator.share exact
{ function g({ x } = a || navigator.share) {} } //~ api.Navigator.share exact
{ function g([x] = a || navigator.share) {} } //~ api.Navigator.share exact
{ const { y: { x } = a || navigator.share } = o; } //~ api.Navigator.share exact
({ y: { x } = a || navigator.share } = o); //~ api.Navigator.share exact
{ class C extends (a || navigator.share) {} } //~ api.Navigator.share exact
{ function* g() { yield* (a || navigator.share); } } //~ api.Navigator.share exact
(0, a || navigator.share)(x); //~ api.Navigator.share exact
f(...(a || navigator.share)); //~ api.Navigator.share exact
new F(...(a || navigator.share)); //~ api.Navigator.share exact

// a_logical_whose_value_is_stored_is_a_check: these forms keep `undefined` without reading from it.
x = a || navigator.share; //~ none
{ function g(x = a || navigator.share) {} } //~ none
{ const { y = a || navigator.share } = o; } //~ none
({ y = a || navigator.share } = o); //~ none
o = { m: a || navigator.share }; //~ none
{ function* g() { yield a || navigator.share; } } //~ none
(a || navigator.share, 0)(x); //~ none
x = (0, a || navigator.share); //~ none
// Object spread skips `undefined`.
x = { ...(a || navigator.share) }; //~ none
