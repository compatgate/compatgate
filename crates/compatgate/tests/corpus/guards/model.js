// The flow model of guards: facts follow the control flow, a dropped value is no use, and the root of a
// chain is a use of its own.

// the_test_of_a_loop_guards_its_body
while (navigator.share) { navigator.share(d); } //~ none
for (let i = 0; navigator.share && i < n; i++) { navigator.share(d); } //~ none
// The body of `do … while` runs before the test.
do { navigator.share(d); } while (navigator.share); //~ api.Navigator.share exact
// The loop ends when the test is false, so the code after it is not guarded.
function m0() { while (navigator.share) { break; } navigator.share(d); } //~ api.Navigator.share exact

// an_if_with_one_exiting_branch_guards_the_code_after_it
function m1() { if (navigator.share) { x(); } else { return; } navigator.share(d); } //~ none
function m2() { if (!navigator.share) { return; } else { x(); } navigator.share(d); } //~ none
function m3() { if (navigator.share) { return; } else { x(); } navigator.share(d); } //~ api.Navigator.share exact
function m4() { if (!navigator.share) { if (a) { return; } else { throw e; } } navigator.share(d); } //~ none
// Only one branch of the inner `if` exits.
function m5() { if (!navigator.share) { if (a) return; } navigator.share(d); } //~ api.Navigator.share exact
// The facts of an early exit hold after the block that holds it.
function m6() { { if (!navigator.share) return; } navigator.share(d); } //~ none
// An exit after the use does not guard it.
function m7() { navigator.share(d); if (!navigator.share) return; } //~ api.Navigator.share exact

// a_disjunction_guards_what_each_side_proves
function m8() { if (!navigator.share || !a) return; navigator.share(d); } //~ none
function m9() { if (!navigator.share && !a) return; navigator.share(d); } //~ api.Navigator.share exact
if (typeof navigator.share === 'function' || navigator.share instanceof Function) navigator.share(d); //~ none
if (navigator.share || a) navigator.share(d); //~ api.Navigator.share exact
if (a ? navigator.share : navigator.share) navigator.share(d); //~ none
if (a ? navigator.share : b) navigator.share(d); //~ api.Navigator.share exact

// instanceof_reads_its_left_operand_safely
if (navigator.share instanceof Function) navigator.share(d); //~ none
// The right operand of `instanceof` throws when it is not callable.
if (x instanceof navigator.share) {} //~ api.Navigator.share exact

// a_dropped_value_is_no_use
navigator.share; //~ none
void navigator.share; //~ none
x = (navigator.share, c); //~ none
// The value is read further, so the read throws.
navigator.share.length; //~ api.Navigator.share exact

// an_optional_value_that_is_called_is_a_use: `?:` and an assignment pass the value on.
(c ? a || navigator.share : b)(d); //~ api.Navigator.share exact
(y = a || navigator.share)(d); //~ api.Navigator.share exact

// the_root_of_a_chain_is_a_use_of_its_own: where `navigation` is missing, reading it throws.
navigation.currentEntry; //~ api.Window.navigation exact
window.navigation.currentEntry.url; //~ api.Window.navigation exact
{ const { currentEntry } = navigation; } //~ api.Window.navigation exact
typeof navigation; //~ none
if (navigation.currentEntry) x(); //~ api.Window.navigation exact
// Every browser without `Navigation.navigate` lacks `navigation`, so a check of the root covers it.
if (window.navigation) navigation.navigate('/'); //~ none
if (typeof navigation === 'object') navigation.navigate('/'); //~ none
// Chrome 97 has `scheduler` but not `Scheduler.yield`, so the member is a use too. Every browser without
// `scheduler` lacks `Scheduler.yield`, so the finding of the member tells about the root as well.
scheduler.yield(); //~ api.Scheduler.yield exact
if (window.scheduler) scheduler.yield(); //~ api.Scheduler.yield exact
// The member is no finding here, so the root reports itself.
typeof scheduler.yield; //~ api.scheduler exact
// A destructuring reads the root once for all its members, so the root stays.
{ const { yield: y } = scheduler; } //~ api.Scheduler.yield exact; api.scheduler exact
// Where `scheduler.yield` is present, `scheduler` is present too.
if (scheduler.yield) scheduler.yield(); //~ api.scheduler exact

// a_test_with_one_value_proves_everything_where_it_has_the_other: `void 0` is never true.
if (c ? void 0 : navigator.share) navigator.share(d); //~ none
if (c ? undefined : navigator.share) navigator.share(d); //~ none
if (c ? null : false || navigator.share) navigator.share(d); //~ none
if (navigator.share && 1 && 'yes' && true) navigator.share(d); //~ none
// `true` proves nothing about `navigator.share`.
if (c ? true : navigator.share) navigator.share(d); //~ api.Navigator.share exact
function m10() { if (!navigator.share || 0) return; navigator.share(d); } //~ none
// A constant inside a chain keeps its meaning: `false && a` is never true.
if ((false && a) || navigator.share) navigator.share(d); //~ none
if ((a && void 0) || navigator.share) navigator.share(d); //~ none
if (!(a || 1) || navigator.share) navigator.share(d); //~ none
if ((a && null) ? b : navigator.share) navigator.share(d); //~ none
if ((a && null) ? b : c) navigator.share(d); //~ api.Navigator.share exact

// a_check_of_another_feature_covers_a_use_that_it_implies: every target version without
// `Object.groupBy` lacks `Promise.withResolvers` too. The other way round does not hold.
if (Promise.withResolvers) Object.groupBy(a, f); //~ none
if (Object.groupBy) Promise.withResolvers(); //~ javascript.builtins.Promise.withResolvers exact

// a_default_value_replaces_a_missing_member: as with `??`, the code expects that it may be missing.
{ const { share = f } = navigator; } //~ none
{ const { share: s = f } = navigator; } //~ none
{ let share; ({ share = f } = navigator); } //~ none
{ let s; ({ share: s = f } = navigator); } //~ none
// Without a default the name holds `undefined`, and a default of another property does not help.
{ const { share, canShare = f } = navigator; } //~ api.Navigator.share exact
{ let s; ({ share: s } = navigator); } //~ api.Navigator.share exact

// the_init_and_the_update_of_a_for_loop_are_dropped
for (navigator.share; ; ) break; //~ none
for (; ; navigator.share) break; //~ none
// The value is read further, or it is stored.
for (navigator.share.length; ; ) break; //~ api.Navigator.share exact
for (let s = navigator.share; ; ) break; //~ api.Navigator.share exact

// a_checked_path_proves_its_prefixes: where `navigator.share.call` is present, `navigator.share` is too.
if (navigator.share?.call) navigator.share(d); //~ none
if (typeof navigator.share?.call === 'function') navigator.share(d); //~ none
if (list.toSorted?.call) list.toSorted(); //~ none
// A prefix proves nothing about the path, a path proves nothing about its siblings, and a missing path
// proves nothing about its prefix.
if (navigator.share) navigator.share.call(n, d); //~ none
if (navigator.share?.call) navigator.canShare(d); //~ api.Navigator.canShare exact
function m11() { if (navigator.share?.call) return; navigator.share(d); } //~ api.Navigator.share exact
