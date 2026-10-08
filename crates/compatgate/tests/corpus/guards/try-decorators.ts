// try_catches_what_a_decorator_of_a_field_runs: a decorator runs when the class is defined.
try { class K { @dec(structuredClone(a)) f = 1; } } catch {} //~ javascript.classes.public_class_fields partial
try { class K { @dec(structuredClone(a)) accessor f = 1; } } catch {} //~ none
// The value of the field runs later, when the class makes an object.
try { class K { @dec f = structuredClone(a); } } catch {} //~ javascript.classes.public_class_fields partial; api.structuredClone exact
