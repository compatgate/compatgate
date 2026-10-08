// `try` with a `catch` guards a call or a `new` in the same function.

// try_guards_calls_and_constructors_only
try { new Intl.Segmenter(); } catch {} //~ none
try { new RegExp('(?<=a)b'); } catch {} //~ none
try { /(?<=a)b/; } catch {} //~ javascript.regular_expressions.lookbehind_assertion exact
try { Intl.Segmenter; } catch {} //~ javascript.builtins.Intl.Segmenter exact

// try_guards_only_with_a_catch_and_inside_the_same_function
try { new Intl.Segmenter(); } finally {} //~ javascript.builtins.Intl.Segmenter exact
try { setTimeout(() => new Intl.Segmenter()); } catch {} //~ javascript.builtins.Intl.Segmenter exact

// a_member_called_through_a_wrapper_is_a_call (the TypeScript case is in `typescript.ts`)
try { (0, window.structuredClone)(1); } catch (e) {} //~ none
(0, window.structuredClone)?.(1); //~ none
(0, structuredClone)?.(1); //~ api.structuredClone exact

// a_member_called_through_an_optional_chain_is_a_call
x = (window?.structuredClone)?.(1); //~ none
x = (0, window?.structuredClone)?.(1); //~ none
try { (window?.structuredClone)(1); } catch (e) {} //~ none
try { window?.structuredClone; } catch (e) {} //~ api.structuredClone exact
