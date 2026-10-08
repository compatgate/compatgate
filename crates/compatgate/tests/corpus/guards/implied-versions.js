// targets: Chrome >= 97

// a_check_covers_a_use_only_where_every_target_version_without_the_use_lacks_the_checked_feature:
// Chrome 97 lacks both, but Chrome 98 to 116 have `structuredClone` without `Object.groupBy`.
if (window.structuredClone) Object.groupBy(a, f); //~ javascript.builtins.Object.groupBy exact
if (window.structuredClone) structuredClone(x); //~ none
