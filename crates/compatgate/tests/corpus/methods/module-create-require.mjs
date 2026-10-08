// a_require_made_by_create_require_or_webpack_is_the_module_loader
import module from 'module'; //~ none
const require = module.createRequire(import.meta.url); //~ none
require('ramda').take(1); //~ none
