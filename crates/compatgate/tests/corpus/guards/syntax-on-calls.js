// targets: Chrome >= 50

// syntax_on_a_call_is_not_protected_by_try_or_an_optional_call. The default targets support trailing
// commas in calls, so the file uses an old Chrome. The syntax detector puts them on the comma inside the
// call, but a parse-time error cannot be caught.
f(a,); //~ javascript.grammar.trailing_commas.trailing_commas_in_functions exact
try { f(a,); } catch (e) {} //~ javascript.grammar.trailing_commas.trailing_commas_in_functions exact
a.b?.(x,); //~ javascript.operators.optional_chaining exact; javascript.grammar.trailing_commas.trailing_commas_in_functions exact
