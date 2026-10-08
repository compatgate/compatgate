// a_local_function_named_require_is_not_a_module_loader
function require() { return {}; } //~ none
require('x').take(1); //~ javascript.builtins.Iterator.take heuristic
