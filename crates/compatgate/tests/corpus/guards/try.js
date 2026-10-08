// `try` with a `catch` guards what throws in the same function: a call, a `new`, a read from a missing value.

// try_guards_what_throws
try { new Intl.Segmenter(); } catch {} //~ none
try { new RegExp('(?<=a)b'); } catch {} //~ none
try { Intl.Segmenter.supportedLocalesOf(['en']); } catch {} //~ none
try { structuredClone; } catch {} //~ none
// A file with new syntax does not parse, so nothing in it runs.
try { /(?<=a)b/; } catch {} //~ javascript.regular_expressions.lookbehind_assertion exact
// A raw value that escapes throws nothing in the `try`; the code that receives it fails later.
try { x = Intl.Segmenter; } catch {} //~ javascript.builtins.Intl.Segmenter exact
// A dropped value is no use at all.
try { Intl.Segmenter; } catch {} //~ none

// try_guards_only_with_a_catch_and_inside_the_same_function
try { new Intl.Segmenter(); } finally {} //~ javascript.builtins.Intl.Segmenter exact
try { setTimeout(() => new Intl.Segmenter()); } catch {} //~ javascript.builtins.Intl.Segmenter exact
// An instance field and an accessor get their value when the class makes an object, after the `try`.
// Static initializers run with the class, inside the `try`.
try { class A { f = navigator.share(d); } } catch {} //~ javascript.classes.public_class_fields partial; api.Navigator.share exact
try { class A { accessor f = navigator.share(d); } } catch {} //~ api.Navigator.share exact
try { class A { static f = navigator.share(d); } } catch {} //~ none
try { class A { static { navigator.share(d); } } } catch {} //~ javascript.classes.static.initialization_blocks exact
// Computed keys and decorators run when the class is defined, inside the `try`.
try { class K { [structuredClone(a)] = 1; } } catch {} //~ javascript.classes.public_class_fields partial
try { class K { accessor [structuredClone(a)] = 1; } } catch {} //~ none
try { class K { f = 1; [structuredClone(a)] = 2; } } catch {} //~ @17 javascript.classes.public_class_fields partial; @24 javascript.classes.public_class_fields partial

// a_member_called_through_a_wrapper_is_a_call (the TypeScript case is in `typescript.ts`)
try { (0, window.structuredClone)(1); } catch (e) {} //~ none
(0, window.structuredClone)?.(1); //~ none
(0, structuredClone)?.(1); //~ api.structuredClone exact

// a_member_called_through_an_optional_chain_is_a_call
x = (window?.structuredClone)?.(1); //~ none
x = (0, window?.structuredClone)?.(1); //~ none
try { (window?.structuredClone)(1); } catch (e) {} //~ none
try { window?.structuredClone; } catch (e) {} //~ none
