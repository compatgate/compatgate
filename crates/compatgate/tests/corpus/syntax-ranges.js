// targets: Chrome >= 30

// A syntax finding starts at the token of the feature, not at the start of its node: nested nodes of one
// feature start at different columns. `packages/core/docs/syntax-ranges.md` lists the token of each key.
x = a ?? b ?? c; //~ @7 javascript.operators.nullish_coalescing exact; @12 javascript.operators.nullish_coalescing exact
x = a ** b ** c; //~ @7 javascript.operators.exponentiation exact; @12 javascript.operators.exponentiation exact
x = a => b => c; //~ @7 javascript.functions.arrow_functions exact; @12 javascript.functions.arrow_functions exact
x = { async m() {}, async n() {} }; //~ @7 javascript.functions.method_definitions.async_methods exact; @13 javascript.functions.method_definitions exact; @13 javascript.operators.object_initializer.shorthand_method_names exact; @21 javascript.functions.method_definitions.async_methods exact; @27 javascript.functions.method_definitions exact; @27 javascript.operators.object_initializer.shorthand_method_names exact
x = a?.b ?? c?.d; //~ @6 javascript.operators.optional_chaining exact; javascript.operators.nullish_coalescing exact; @14 javascript.operators.optional_chaining exact
x = { [k]: 1, [j]: 2 }; //~ @7 javascript.operators.object_initializer.computed_property_names exact; @15 javascript.operators.object_initializer.computed_property_names exact
function g(a = 1, b = 2) {} //~ @14 javascript.functions.default_parameters exact; @21 javascript.functions.default_parameters exact
