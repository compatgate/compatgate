// The value of a sequence is its last expression. Coverage instrumentation wraps operands in
// sequences: `(cov().b[1][1]++, navigator.share)`.

// the_last_expression_of_a_sequence_is_tested_as_the_sequence (the instrumented function is in
// `coverage-instrumented.js`)
if ((c++, navigator.share)) navigator.share(d); //~ none
{ const ok = typeof navigator !== 'undefined' && (c++, navigator.share); } //~ none
{ const ok = Boolean((c++, window.navigator?.share)); } //~ none
{ function f() { if (!(c++, navigator.share)) return; navigator.share(d); } } //~ none

// other_expressions_of_a_sequence_are_not_tested: the value of the sequence is `c`. The read is dropped,
// so it is no use, and it does not guard the call.
if ((navigator.share, c)) navigator.share(d); //~ api.Navigator.share exact
