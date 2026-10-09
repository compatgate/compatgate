# How checks work

This page describes the model behind the findings of `@compatgate/core`.
The [README](../README.md) has the short version.

## What it checks

- **Syntax** newer than your targets: class fields and static blocks, `??=`, optional catch binding and more.
  Module syntax (`import`, `export`, `import()`, top-level `await`) is not checked: bundlers replace it.
- **Regular expressions**: lookbehind, named groups, modifiers, `\p{…}`, the `d`, `s`, `v`, `y` and `u` flags,
  in literals and in `RegExp()` with string arguments.
- **Builtins and Web APIs** reached as globals: `structuredClone()`, `new Intl.Segmenter()`, `Object.groupBy()`
  and members of singletons such as `navigator.userActivation`. `window.X`, `self.X` and `globalThis.X` count
  as the global `X`, also through chains such as `window.navigator.userActivation`.
  Destructuring from a global is a member use: `const { userActivation } = navigator`,
  `const { groupBy } = Object`. Members of a singleton resolve through its parent interfaces:
  `document.when()` is `api.EventTarget.when`. A local `window` or `Intl` that shadows the global
  (for example a parameter of a UMD wrapper) is not the global.
- **Prototype methods** by name, such as `.toSorted()`. A method is read as `arr.toSorted` or
  `arr['toSorted']`, and the guards follow the value of the read like the value of any member.
  The receiver of a literal has a known type: `[]`, `new Set()`, `new Map()`, a string, a template,
  a regular expression, a number, a BigInt and a boolean. Its finding names the method of that type and is exact:
  `[3, 1].toSorted()` reports `javascript.builtins.Array.toSorted`, and `'abc'.toSorted()` reports nothing.
  Names that the file declares do not skip it.
- For another receiver the findings are heuristic. A read is a use only when the code calls its value:
  `arr.toSorted()`, `arr.toSorted.call(x)`, `arr.toSorted.apply(x, [])`, `(0, arr.toSorted)()` and
  `const f = arr.toSorted; f(x)` are uses, while `if (arr.toSorted)` and `for (c of compilation.chunks)`
  are not: many objects have data properties with method names. A destructured method,
  `const { toSorted } = arr`, is not a use either. Other call shapes are not followed:
  `(c ? x.m : y.m)()`, `(x.m || f)()`, `x.m.bind(o)()`, `new x.m()`, ``x.m`…` ``, and a variable that is
  no alias, such as one written twice. Names that a supported
  method also has (`.map()`), names that the file declares as members itself (`class Q { union() {} }`,
  `class Q { take = 1 }`, accessors, `{ take() {} }`, `{ take: f }`, `obj.take = f`, `obj['take'] = f`)
  and calls on imported or required modules (`_.union()`) are skipped. A `require` result is skipped when
  `require` is the CommonJS global, a function parameter, a `declare`d `require`, or a variable that holds
  `createRequire(...)`, `module.createRequire(...)` or `__webpack_require__`.
  Minified webpack calls `__webpack_require__` by the third parameter of the module function, `n(96540)`
  or `n("./src/a.js")`, so a call of the third parameter of a function with one integer or string literal
  is a module too.
  Transpiled wrappers such as `__importDefault(require('x'))`
  and `_interopRequireDefault(...)`, `(0, m)`, and `.default` of a module, are skipped too.
  A name declared in another module still gives a finding: `valids.toArray()` calls a class of a
  neighbouring file, and the checker sees one file at a time.
  When several methods share a name, the finding names the one with the worst support.
  Members of `DisposableStack` and `AsyncDisposableStack` are not checked as prototype methods:
  their names (`use`, `dispose`, `move`, `adopt`, `defer`) are also methods of Vue, express and three.js.
  Their constructors are still checked. Getters such as `description`, `detached` and `resizable`
  are never treated as methods.

Each finding has a confidence: `exact`, `heuristic` (a method found by name) or `partial`
(some targets support the feature only in part; `unsupported[].note` explains the limit). A heuristic
finding stays `heuristic` under partial support and keeps the note.

Support is checked in every released version of a browser from its lowest target version on.
A removal in a beta, nightly or planned release does not count until that release is out.

## Guards

A use under a check of the same feature is not a finding:

```js
if ('Segmenter' in Intl) new Intl.Segmenter();
typeof structuredClone === 'function' ? structuredClone(value) : clone(value);
list.toSorted?.();
try {
  new RegExp('(?<=a)b');
} catch {}
```

Rules for checks. A use is no finding when the code drops its value or when a check protects it.
Three tables decide it.

1. Where the value goes. A bare global such as `structuredClone` throws when it is missing, except under
   `typeof`. A member such as `navigator.share` reads as `undefined`, and its parents decide what follows:

   | The value is                  | Examples                                                                                                                                         | Result                                           |
   | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
   | passed on                     | `(X)`, `X as T`, `(a, X)`, `await X`, `y = X`                                                                                                    | as at the parent                                 |
   | made optional                 | `a \|\| X`, `a && X`, `X && a`, `a ?? X`, `c ? X : a`, `X?.y`, `X?.()`                                                                           | as at the parent, optional                       |
   | dropped or tested             | `X;`, `(X, a)`, `X \|\| a`, `X ?? a`, `!X`, `typeof X`, `X === a`, `X instanceof F`, `Boolean(X)`, `if (X)`, `{ ...X }`, `for (k in X)`          | no finding                                       |
   | used where `undefined` throws | `X.y`, `X()`, `new X`, `` X`…` ``, `'p' in X`, `a instanceof X`, `[...X]`, `f(...X)`, `for (a of X)`, `yield* X`, `extends X`, `const { a } = X` | a finding, unless a check or a `try` protects it |
   | stored or passed              | `o.y = X`, `f(X)`, `return X`, `{ a: X }`, `` `${X}` ``                                                                                          | a finding, unless a check protects it            |
   | held by an alias `y`          | `const y = X`, `const { p: y } = X` for `X.p`, `var y; y = X`                                                                                    | as at every read of `y`                          |

   `y = X` both passes the value on and stores it, and the worse result counts: `y = navigator.share;` is a
   finding when `y` is no alias, `(y = a || navigator.share)(d)` too. An alias passes the raw value on to its
   reads: `const s = navigator.share; s(d)` is a finding, `const s = navigator.share; if (s) s(d)` is not.
   The init and the update of `for (X; ; X)` are dropped like `X;`. A default value replaces a missing
   property, as `??` does: `const { share = f } = navigator; g(share)` is no finding,
   `const { share } = navigator; g(share)` is.

2. Where a check holds:

   | Code                                                     | The check `T` holds in                     |
   | -------------------------------------------------------- | ------------------------------------------ |
   | `if (T) A; else B`, `T ? A : B`                          | `A` with `T` true, `B` with `T` false      |
   | `while (T) A`, `for (; T; ) A`                           | `A` with `T` true; not in `do A while (T)` |
   | `T && A`, `T \|\| A`                                     | `A` with `T` true, with `T` false          |
   | `if (T) return;`, `if (T) {} else throw e;`, other exits | the code after it, with `T` false, true    |

   The code after an exit is the rest of its statement list. Facts leave only a plain nested block
   `{ … }`: `{ if (!X) return; } X();` is protected. They do not leave the body of an `if`, of a loop,
   of a function or any other list.

3. What a check proves:

   | Check                                                                                                                      | Proves present when it is true         | when it is false             |
   | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------- |
   | `X`, `typeof X === 'function'` or `'object'`, `typeof X !== 'undefined'`, `X != null`, `X !== undefined`, `X instanceof F` | `X`                                    | nothing                      |
   | `typeof X === 'undefined'`, `X == null`, `X === undefined`                                                                 | nothing                                | `X`                          |
   | `'p' in X`                                                                                                                 | `X.p`                                  | nothing                      |
   | `!T`, `(a, T)`, `Boolean(T)`, `y = T`                                                                                      | as `T`; `!` swaps true and false       |                              |
   | `y`, an alias of `X`                                                                                                       | as `X`                                 |                              |
   | `A && B`, `A \|\| B`                                                                                                       | both, what both prove                  | what both prove, both        |
   | `c ? A : B`                                                                                                                | what both `c && A` and `!c && B` prove | the same with `A`, `B` false |
   | `void 0`, `undefined`, `null`, `false`, `0`, `""`                                                                          | everything                             | nothing                      |
   | `true`, other numbers, other strings                                                                                       | nothing                                | everything                   |

   A test that never has a value proves everything there: that code never runs. So
   `if (c ? void 0 : navigator.share) navigator.share(d)` is protected.

   Minified forms such as `typeof X<"u"` and `void 0 !== window.X` count. A check of a path proves its
   prefixes too: where `navigator.share?.call` is present, `navigator.share` is. A check proves `X` for uses of
   `X`, and `a.m` for uses `b.m()` of a method found by name. It also proves a use that every target
   version without full support of the use lacks `X` in: `if (window.navigation) navigation.navigate('/')`.
   The root of a chain is a use of its own: `navigation.currentEntry` reports `api.Window.navigation`,
   and the member only where the root does not cover its gap. When the member covers the gap of the root
   instead, the member reports both: `scheduler.yield()` is one finding, `api.Scheduler.yield`.

## More rules

- A `try` with a `catch` protects whatever throws in its block in the same function, not in a callback
  or in the initializer of an instance field defined there: those run after the `try`.
- A value that passed `||`, `&&`, `??`, `?:` or `?.` is no finding where it escapes: `const f = a || navigator.share`
  is not a finding, `const f = navigator.share; g(f)` is. The checker does not follow such a value into an
  alias: a check of the alias would not prove the use present.
- An alias is a variable that holds the value of one expression wherever it holds a value: a `const`, a `let`
  or `var` with an initializer and no writes, and a `let` or `var` without an initializer that the code writes
  once with `y = X`. Downleveled optional chains write such a temporary variable:
  `null == (t = navigator.share) ? void 0 : t.call(navigator, d)` is protected. Before its write the variable
  is `undefined`, and a check of it is false there. A variable with another write, a parameter, a loop variable
  of `for … of` and `for … in`, and an exported variable are no aliases. An alias without reads is no finding.
  A check of an alias of an alias proves its expression at any depth. A use is followed into aliases of
  aliases to a depth of 16; deeper, its value escapes, and the use is a finding.
- Some code writes a variable without naming it, and such a variable is no alias either:
  - a top-level `var` or `let` of a script: the scripts of a page share their top-level names. A top-level
    `const` stays an alias, since nothing writes it. The checker cannot tell a script of a page from CommonJS,
    whose top level is private, so CommonJS loses these aliases too;
  - a `var` or `let` that a direct `eval` sees;
  - a `var` of a function that declares a function of the same name in a block, in sloppy code;
  - a variable that the code reads in the body of a `with`: the name may be a property of the object.
- Syntax is never protected: a file with it does not parse.
- A check on a shadowed local `window` or `Intl` does not protect uses of the global.
- A write that defines a global (`structuredClone = function () {}`) is not a use.
  Neither are a write through destructuring (`[window.X] = a`) and `delete window.X`.
