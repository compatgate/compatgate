// Syntax.

// support_that_a_later_release_replaced_is_partial: Safari 15.6 supports class fields partially.
{ class A { x = 1; } } //~ javascript.classes.public_class_fields partial

// Safari supports static blocks since 16.4, so the default targets need a finding. Bundlers lower them for
// these targets: Babel's transform-class-static-block has safari 16.4 too.
{ class A { static {} } } //~ javascript.classes.static.initialization_blocks exact
// Safari 15.6 supports static and private fields fully; only public instance fields are partial.
{ class A { static x = 1; #y = 2; static #z = 3; } } //~ none
let a; a ??= 1; //~ none
