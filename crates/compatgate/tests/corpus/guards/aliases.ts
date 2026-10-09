// Aliases in a module and in TypeScript.

// an_exported_variable_is_no_alias: other modules read it.
export const s1 = navigator.share; //~ api.Navigator.share exact
const s2 = navigator.share; export { s2 }; //~ api.Navigator.share exact
export let s3; s3 = navigator.share; //~ api.Navigator.share exact
// A top-level variable of a module is an alias: no other code writes it.
var s4 = navigator.share; if (s4) s4(d); //~ none

// a_type_is_no_read
{ const s = navigator.share; let t: typeof s; if (s) s(d); } //~ none
{ const s = navigator.share as (data: unknown) => void; if (s) s(d); } //~ none
{ const s = navigator.share!; s(d); } //~ api.Navigator.share exact
