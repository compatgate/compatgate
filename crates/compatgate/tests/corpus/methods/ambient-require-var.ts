// an_ambient_declaration_of_require_is_the_module_loader
declare var require: any; //~ none
const R = require('ramda'); //~ none
R.take(1); //~ none
