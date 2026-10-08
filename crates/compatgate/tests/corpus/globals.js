// Globals, their members and destructuring from them.

// finds_a_member_of_a_global_builtin
new Intl.Segmenter('en'); //~ javascript.builtins.Intl.Segmenter exact
Object.groupBy([], x => x); //~ javascript.builtins.Object.groupBy exact

// ignores_features_present_in_all_targets
[1].at(-1); new Map(); Object.keys({}); fetch('/'); Intl.DateTimeFormat; //~ none

// ignores_unknown_globals
__DEV__ && process.env.NODE_ENV; //~ none

// ignores_a_local_binding_with_a_global_name
{ function f() { const structuredClone = x => x; return structuredClone(1); } } //~ none

// writes_and_deletes_of_globals_are_not_uses
[window.structuredClone] = a; //~ none
({ a: Object.groupBy } = o); //~ none
for (window.structuredClone of list) {} //~ none
delete window.structuredClone; //~ none
delete window?.structuredClone; //~ none

// typeof_a_member_of_a_window_alias_is_a_check
typeof window.structuredClone; //~ none

// an_optional_member_of_a_window_alias_is_reported
window?.structuredClone(1); //~ api.structuredClone exact

// destructuring_from_a_global_is_a_member_use
{
  const { userActivation } = navigator; //~ api.Navigator.userActivation exact
  const { groupBy } = Object; //~ javascript.builtins.Object.groupBy exact
  const { structuredClone } = window; //~ api.structuredClone exact
}

// a_check_guards_destructuring_from_a_global
if (navigator.userActivation) { const { userActivation } = navigator; } //~ none
{
  if (!Object.groupBy) throw new Error(); //~ none
  const { groupBy } = Object; //~ none
}
if (typeof structuredClone === 'function') { const { structuredClone } = window; } //~ none

// a_member_of_a_parent_interface_is_found_for_a_singleton
document.when('click'); //~ api.EventTarget.when exact

// a_member_of_a_parent_interface_is_found_for_the_global_object
window.when('click'); //~ api.EventTarget.when exact
when('click'); //~ api.EventTarget.when exact
window.addEventListener('a', f); addEventListener('a', f); //~ none
if (typeof when === 'function') { when('click'); } //~ none

// destructuring_from_a_member_of_a_window_alias_is_a_member_use
{ const { share } = window.navigator; } //~ api.Navigator.share exact
if (navigator.share) { const { share } = window.navigator; } //~ none
