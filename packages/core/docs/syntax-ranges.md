# Ranges of syntax findings

A syntax finding covers the token of the feature, not the whole node: the keyword `static` of a static block,
the operator `??=`, the name of a private field. An editor underlines a few characters instead of a class of
a hundred lines, and a bundler prints a short code frame. `start`, `end` and `range` of the finding all
describe this token.

oxc keeps the spans of nodes, not of keywords and operators. The checker finds a token in one of three ways:

- **node**: the span of an AST node that is the token itself, such as a literal, a name or a key;
- **source**: a scan of the source text from the boundary of a node: whitespace and comments are skipped,
  and the token must be next. Decorators are skipped by their spans, so `@d([1]) static x` finds `static`;
- **prefix**: the first characters of a node that always starts with the token, such as `static {`. The text
  is checked too.

If the source does not show the token where the grammar puts it, the finding covers the whole node, as before;
for `extends` it covers the superclass expression. The tests know of no valid program that reaches this
fallback.

| Feature                                                                                                                                      | Range                                              | Example                      | Found by               |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------- | ---------------------- |
| `javascript.grammar.binary_numeric_literals`, `octal_numeric_literals`, `numeric_separators`, `javascript.builtins.BigInt`                   | the literal                                        | `0b101`, `1_000`, `10n`      | node                   |
| `javascript.grammar.unicode_point_escapes`                                                                                                   | the first escape of the string or template element | `\u{1F600}`                  | source                 |
| `javascript.grammar.template_literals`                                                                                                       | the opening backtick                               | `` ` ``                      | prefix                 |
| `javascript.grammar.template_literals.template_literal_revision`                                                                             | the first quasi with an invalid escape             | `\unicode`                   | node                   |
| `javascript.grammar.trailing_commas.trailing_commas_in_functions`                                                                            | the trailing comma                                 | `,`                          | source                 |
| `javascript.operators.nullish_coalescing`, `exponentiation`                                                                                  | the operator                                       | `??`, `**`                   | source                 |
| `javascript.operators.nullish_coalescing_assignment`, `logical_and_assignment`, `logical_or_assignment`, `exponentiation_assignment`         | the operator                                       | `??=`, `&&=`, `\|\|=`, `**=` | source                 |
| `javascript.operators.increment`, `decrement`                                                                                                | the operator: the first or the last two characters | `++`, `--`                   | prefix                 |
| `javascript.operators.optional_chaining`                                                                                                     | the first `?.` of the chain                        | `?.`                         | source                 |
| `javascript.operators.spread.*`, `javascript.operators.destructuring.rest_in_*`, `javascript.functions.rest_parameters` and `.destructuring` | the dots                                           | `...`                        | prefix                 |
| `javascript.operators.destructuring`                                                                                                         | the opening bracket of the pattern                 | `{`, `[`                     | prefix                 |
| `javascript.operators.destructuring.computed_property_names`, `javascript.operators.object_initializer.computed_property_names`              | the key with its brackets                          | `[k]`                        | source                 |
| `javascript.functions.get.computed_property_names`, `javascript.functions.set.computed_property_names`                                       | the key with its brackets                          | `[k]`                        | source                 |
| `javascript.operators.object_initializer.shorthand_property_names`                                                                           | the name                                           | `a`                          | node                   |
| `javascript.operators.object_initializer.shorthand_method_names`, `javascript.functions.method_definitions`                                  | the key; a computed key with its brackets          | `m`, `#m`, `[k]`             | node; source for `[k]` |
| `javascript.functions.method_definitions.async_methods`                                                                                      | the keyword                                        | `async`                      | source                 |
| `javascript.functions.method_definitions.async_generator_methods`                                                                            | the keyword and the star                           | `async *`                    | source                 |
| `javascript.operators.async_function`, `async_generator_function`, `generator_function`; the same keys of `javascript.statements`            | the keywords before the name                       | `async function*`            | source                 |
| `javascript.operators.async_function` for an arrow function                                                                                  | the keyword                                        | `async`                      | prefix                 |
| `javascript.functions.block_level_functions`                                                                                                 | the keywords before the name                       | `function`                   | source                 |
| `javascript.functions.arrow_functions`                                                                                                       | the arrow                                          | `=>`                         | source                 |
| `javascript.functions.default_parameters` and `.destructured_parameter_with_default_value_assignment`                                        | the equals sign                                    | `=`                          | source                 |
| `javascript.functions.default_parameters.parameters_without_defaults_after_default_parameters`                                               | the name, or the opening bracket of a pattern      | `b`, `{`                     | node                   |
| `javascript.operators.await`, `yield`                                                                                                        | the keyword                                        | `await`, `yield`             | prefix                 |
| `javascript.operators.yield_star`                                                                                                            | the keyword and the star                           | `yield*`                     | source                 |
| `javascript.operators.super`, `new_target`                                                                                                   | the keyword                                        | `super`, `new.target`        | node                   |
| `javascript.statements.class`, `javascript.operators.class`                                                                                  | the keyword, after decorators and `abstract`       | `class`                      | source                 |
| `javascript.classes.extends`                                                                                                                 | the keyword                                        | `extends`                    | source                 |
| `javascript.classes.constructor`                                                                                                             | the key                                            | `constructor`                | node                   |
| `javascript.classes.static`, `javascript.classes.static.class_fields`                                                                        | the keyword, after decorators and other modifiers  | `static`                     | source                 |
| `javascript.classes.static.initialization_blocks`                                                                                            | the keyword                                        | `static`                     | prefix                 |
| `javascript.classes.private_class_fields`, `private_class_methods`                                                                           | the private name                                   | `#x`                         | node                   |
| `javascript.classes.private_class_fields_in`                                                                                                 | the private name and the keyword                   | `#x in`                      | source                 |
| `javascript.classes.public_class_fields`                                                                                                     | the key; a computed key with its brackets          | `name`, `[k]`                | node; source for `[k]` |
| `javascript.statements.let`, `const`, `using`                                                                                                | the keyword                                        | `const`                      | prefix                 |
| `javascript.statements.await_using`                                                                                                          | the keywords                                       | `await using`                | source                 |
| `javascript.statements.for_of`                                                                                                               | the keyword                                        | `of`                         | source                 |
| `javascript.statements.for_await_of`                                                                                                         | the keywords                                       | `for await`                  | source                 |
| `javascript.statements.try_catch.optional_catch_binding`                                                                                     | the keyword                                        | `catch`                      | prefix                 |
| `javascript.statements.debugger`                                                                                                             | the keyword, without the semicolon                 | `debugger`                   | prefix                 |
| `javascript.statements.empty`                                                                                                                | the semicolon                                      | `;`                          | node                   |

A source scan skips the parentheses that oxc leaves out of an assignment target: in `(a) ??= 1` the range is
`??=`. A range from one token to another keeps what lies between them: a computed key keeps the comments inside
its brackets, `[ /* c */ k ]`, and so do `yield /* c */ *`, `#x /* c */ in`, `await /* c */ using` and
`for /* c */ await`. A multi-line comment there makes the range cross lines.

## Regular expressions

A regular expression finding covers the token of the feature in the pattern or in the flags.

| Feature                                                                                 | Range                                  | Example                 |
| --------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| `javascript.regular_expressions.lookbehind_assertion`                                   | the start of the assertion             | `(?<=`, `(?<!`          |
| `javascript.regular_expressions.modifier`                                               | the start of the group up to the colon | `(?i:`, `(?i-m:`        |
| `javascript.regular_expressions.named_capturing_group`                                  | the start of the first named group     | `(?<name>`              |
| `javascript.regular_expressions.named_capturing_group.duplicate_named_capturing_groups` | the start of the first repeated name   | the second `(?<name>`   |
| `javascript.regular_expressions.named_backreference`                                    | the reference                          | `\k<name>`              |
| `javascript.regular_expressions.unicode_character_class_escape`                         | the escape                             | `\p{L}`                 |
| `javascript.regular_expressions.character_escape.unicode`                               | the escape, also in a group name       | `\u{1F600}`             |
| `javascript.builtins.RegExp.dotAll`, `hasIndices`, `unicodeSets`, `sticky`, `unicode`   | the flag                               | `s`, `d`, `v`, `y`, `u` |

A feature that the pattern uses several times gives one finding, at its first use.

In `new RegExp(pattern, flags)` the range lies in the argument that carries the feature: the pattern or the
flags. When the argument is written as its value (a string or a template without escapes, `String.raw`, or a
regular expression literal that new flags parse again), the range is the token in it, as in a literal. An
argument with escapes, such as `'\\d(?<=a)'`, has a value that differs from its text: the range is then the
whole argument.
