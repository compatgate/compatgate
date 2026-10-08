// Probes of the guard rules on 9366fb2. Each expectation holds the current result. `// model:` gives the
// result of the planned flow model where it differs: a test of a condition is a safe position, a branch
// of `?:` and the value of an assignment pass the value on, and facts follow the control flow.

// model: api.Navigator.share exact. A branch of `?:` passes the value on, and the call throws.
(c ? a || navigator.share : b)(d); //~ none
// model: api.Navigator.share exact. The value of an assignment is called.
(y = a || navigator.share)(d); //~ none
// model: api.Navigator.share exact. `await` passes the value on.
async function p0() { (await (a || navigator.share))(d); } //~ none
// model: none. The test of a loop guards its body.
while (navigator.share) { navigator.share(d); } //~ @8 api.Navigator.share exact; @27 api.Navigator.share exact
// model: none.
for (; navigator.share; ) { navigator.share(d); } //~ @8 api.Navigator.share exact; @29 api.Navigator.share exact
// model: api.Navigator.share exact, the call. The body runs before the test.
do { navigator.share(d); } while (navigator.share); //~ @6 api.Navigator.share exact; @35 api.Navigator.share exact
// model: none. The left operand of `instanceof` is a safe read and a check.
if (navigator.share instanceof Function) navigator.share(d); //~ @5 api.Navigator.share exact; @42 api.Navigator.share exact
// model: api.Navigator.share exact, the call. The read is safe, but `new Boolean` is always true.
if (new Boolean(navigator.share)) navigator.share(d); //~ @17 api.Navigator.share exact; @35 api.Navigator.share exact
// model: none. `globalThis.Boolean` is the global `Boolean`.
if (globalThis.Boolean(navigator.share)) navigator.share(d); //~ @24 api.Navigator.share exact; @42 api.Navigator.share exact
// model: none. A value that is not the last of a sequence is dropped.
x = (navigator.share, c); //~ api.Navigator.share exact
// model: api.Window.navigation exact. The root of the chain is a use of its own.
if (navigation.currentEntry) x(); //~ none
// model: api.scheduler exact.
if (scheduler.yield) scheduler.yield(); //~ none
// model: none. Where the browsers lack `Navigation.navigate`, they lack `navigation` too.
if (typeof navigation === 'object') navigation.navigate('/'); //~ api.Navigation.navigate exact
// model: none. The `else` branch exits, so the code after the `if` runs only when the test is true.
function p1() { if (navigator.share) {} else return; navigator.share(d); } //~ api.Navigator.share exact
// model: none.
function p2() { if (!navigator.share) { return } else { x(); } navigator.share(d); } //~ api.Navigator.share exact
// model: none. Both branches exit.
function p3() { if (!navigator.share) { if (a) return; else return; } navigator.share(d); } //~ api.Navigator.share exact
// model: none. `s` is a `const` alias of `navigator.share`.
{ const s = navigator.share; if (s) s(d); } //~ api.Navigator.share exact
// model: none. `share` is a `const` alias of `navigator.share`.
{ const { share } = navigator; if (share) share(d); } //~ api.Navigator.share exact
// model: none. The value is dropped.
navigator.share; //~ api.Navigator.share exact
// model: none.
try { navigator.share; } catch {} //~ api.Navigator.share exact

// Where the value goes. The model keeps these results: a raw value that escapes is a use, a value that
// passed `||`, `&&`, `??` or `?:` is not.
{ const f1 = navigator.share; } //~ api.Navigator.share exact
{ const f2 = a || navigator.share; } //~ none
function r1() { return navigator.share; } //~ api.Navigator.share exact
function r2() { return a || navigator.share; } //~ none
g(navigator.share); //~ api.Navigator.share exact
g(a || navigator.share); //~ none
