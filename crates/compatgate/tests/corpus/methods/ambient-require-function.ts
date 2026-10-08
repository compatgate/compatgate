// an_ambient_declaration_of_require_is_the_module_loader
declare function require(id: string): any; //~ none
const R = require('ramda'); //~ none
R.take(1); //~ none
