// allow: ["api.structuredClone", "javascript.builtins.TypedArray.toSorted"]
// A feature id alone suppresses the findings of the feature in every file. A heuristic finding is
// suppressed by an entry for any feature that the code may use: `list` may be a typed array.
structuredClone(v); //~ none
list.toSorted(); //~ none
navigator.share(d); //~ api.Navigator.share exact
// The type of a literal receiver is known, so an entry for another type does not suppress its finding.
[3, 1].toSorted(); //~ javascript.builtins.Array.toSorted exact
