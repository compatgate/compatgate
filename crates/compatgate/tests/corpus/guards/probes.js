// Probes of the guard rules from the review of 9366fb2. Each expectation holds the result of the flow
// model: a test of a condition is a safe position, a branch of `?:` and the value of an assignment pass
// the value on, and facts follow the control flow. `// model:` marks the probes whose planned result
// waits for `const` aliases, which the model does not follow yet.

// A branch of `?:` passes the value on, and the call throws.
(c ? a || navigator.share : b)(d); //~ api.Navigator.share exact
// The value of an assignment is called.
(y = a || navigator.share)(d); //~ api.Navigator.share exact
// `await` passes the value on.
async function p0() { (await (a || navigator.share))(d); } //~ api.Navigator.share exact
// The test of a loop guards its body.
while (navigator.share) { navigator.share(d); } //~ none
for (; navigator.share; ) { navigator.share(d); } //~ none
// The body runs before the test.
do { navigator.share(d); } while (navigator.share); //~ api.Navigator.share exact
// The left operand of `instanceof` is a safe read and a check.
if (navigator.share instanceof Function) navigator.share(d); //~ none
// The read is safe, but `new Boolean` is always true.
if (new Boolean(navigator.share)) navigator.share(d); //~ api.Navigator.share exact
// `globalThis.Boolean` is the global `Boolean`.
if (globalThis.Boolean(navigator.share)) navigator.share(d); //~ none
// A value that is not the last of a sequence is dropped.
x = (navigator.share, c); //~ none
// The root of the chain is a use of its own.
if (navigation.currentEntry) x(); //~ api.Window.navigation exact
// The test reads `scheduler`, which throws where it is missing.
if (scheduler.yield) scheduler.yield(); //~ api.scheduler exact
// Where the browsers lack `Navigation.navigate`, they lack `navigation` too.
if (typeof navigation === 'object') navigation.navigate('/'); //~ none
// The `else` branch exits, so the code after the `if` runs only when the test is true.
function p1() { if (navigator.share) {} else return; navigator.share(d); } //~ none
function p2() { if (!navigator.share) { return } else { x(); } navigator.share(d); } //~ none
// Both branches exit.
function p3() { if (!navigator.share) { if (a) return; else return; } navigator.share(d); } //~ none
// model: none. `s` is a `const` alias of `navigator.share`.
{ const s = navigator.share; if (s) s(d); } //~ api.Navigator.share exact
// model: none. `share` is a `const` alias of `navigator.share`.
{ const { share } = navigator; if (share) share(d); } //~ api.Navigator.share exact
// The value is dropped.
navigator.share; //~ none
// The value is dropped, and nothing throws for the `try` to catch.
try { navigator.share; } catch {} //~ none

// Where the value goes. The model keeps these results: a raw value that escapes is a use, a value that
// passed `||`, `&&`, `??` or `?:` is not.
{ const f1 = navigator.share; } //~ api.Navigator.share exact
{ const f2 = a || navigator.share; } //~ none
function r1() { return navigator.share; } //~ api.Navigator.share exact
function r2() { return a || navigator.share; } //~ none
g(navigator.share); //~ api.Navigator.share exact
g(a || navigator.share); //~ none
