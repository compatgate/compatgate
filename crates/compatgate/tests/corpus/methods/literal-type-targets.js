// targets: Chrome >= 45
// a_literal_receiver_reports_a_method_that_another_type_supports: `String.prototype.includes`
// came in Chrome 41 and `Array.prototype.includes` in Chrome 47, so the name alone gives no finding.
x.includes(1); //~ none
[1].includes(1); //~ javascript.builtins.Array.includes exact
'abc'.includes('a'); //~ none
