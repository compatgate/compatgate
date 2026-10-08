// a_require_made_by_create_require_or_webpack_is_the_module_loader
import { createRequire } from 'module'; //~ none
const require = createRequire(import.meta.url); //~ none
require('ramda').take(1); //~ none
