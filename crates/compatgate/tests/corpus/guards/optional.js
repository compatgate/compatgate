// Optional calls and optional chaining.

// an_optional_method_call_checks_itself
list.toSorted?.(); //~ none
window.structuredClone?.(1); //~ none
list.toSorted(); //~ javascript.builtins.Array.toSorted heuristic

// optional_chaining_on_the_member_checks_it
navigator.userAgentData?.brands; //~ none
navigator.userAgentData?.getHighEntropyValues(['platform']); //~ none
if (navigator.userAgentData?.mobile) {} //~ none
// The optional access comes after `brands` is read from `userAgentData`, which throws when it is missing.
navigator.userAgentData.brands?.length; //~ api.Navigator.userAgentData exact

// an_optional_chain_does_not_protect_code_outside_it
// The parentheses end the chain: `.length` reads from `undefined` and throws.
(window?.structuredClone).length; //~ api.structuredClone exact
// The optional call checks `a`, not its argument.
a?.(window.structuredClone(1)); //~ api.structuredClone exact
