// a_declared_name_skips_the_heuristic_but_not_a_literal_receiver
class Q { toSorted() { return this; } }
q.toSorted(); //~ none
[3, 1].toSorted(); //~ javascript.builtins.Array.toSorted exact
