# @compatgate/core

Finds JavaScript syntax and APIs that your browserslist targets do not support.

This package holds the core and its Node binding. Use it through `@compatgate/eslint`
or `@compatgate/bundler`, or call it directly.

## Usage

```js
import { check } from '@compatgate/core';

const result = check(source, { filename: '/project/src/app.ts' });
for (const finding of result.findings) {
  console.log(finding.feature, finding.start, finding.unsupported);
}
```

`check` finds the browserslist config and `compatgate.jsonc` above `filename`.
Pass `targets` or `allow` to skip the lookup.

A linter or a bundler checks many files with one configuration. It creates a checker once:

```js
import { createChecker, loadAllow, resolveTargets } from '@compatgate/core';

const checker = createChecker({
  targets: resolveTargets('/project/src/index.ts'),
  allow: [...loadAllow('/project/src/index.ts').entries, 'api.structuredClone'],
});
const result = checker.check(source, '/project/src/app.ts');
```

The checker resolves the query, builds the support table and compiles the globs of `allow` once.
It never changes after `createChecker`, so workers can each hold a checker and check at the same time.
`check` keeps the checkers of the 16 most recently used configurations.

`allow` takes feature ids and entries in the form of `compatgate.jsonc`, plus an optional `baseDir`
for relative `files`. Without it, `files` resolve against the `baseDir` option, then against the process
directory. `normalizeAllowEntry(entry, baseDir)` gives the form that `loadAllow` returns.
`validateAllow(allow, targets)` reports entries with an unknown feature id and entries that the targets
support natively.

### Result

```ts
interface CheckResult {
  findings: Finding[];
  usedAllow: number[]; // indexes of the allow entries that suppressed a finding
  ignoredBrowsers: string[]; // browserslist names without compatibility data
  parseError?: {
    kind: 'syntax' | 'unsupported-file';
    message: string; // without the filename and the position
    line?: number; // for a syntax error
    column?: number;
  };
}

interface Finding {
  feature: string; // BCD id, such as 'api.structuredClone'
  kind: 'syntax' | 'builtin' | 'api';
  confidence: 'exact' | 'heuristic' | 'partial';
  alternatives: string[]; // for a heuristic finding: other ids that the same code may use
  start: { line: number; column: number };
  end: { line: number; column: number };
  range: [number, number];
  unsupported: { browser: string; target: string; since?: string; note?: string }[];
}
```

Lines start at 1, columns at 0. Columns and `range` count UTF-16 code units, as JavaScript strings do.
`source.slice(...range)` is the code of the finding. Columns skip a byte order mark, as ESLint does;
`range` counts it.

An `allow` entry for the feature or for any of its `alternatives` suppresses a heuristic finding.

A source that does not parse is no error: the result has no findings and a `parseError`.
A linter shows its own parse errors, and a bundler skips the module. The kind `unsupported-file` means
that the extension selects no parser: `.vue`, `.css`, a file without an extension.
`isCheckable(filename)` tells it before the call.

The filename must be a path. A bundler id such as `/src/a.ts?v=123` has a query: strip `?…` before
the call, as Vite's `cleanUrl` does. compatgate does not strip it itself: `?` and `#` are valid
in file names, and the `files` globs of `allow` match the same filename.

### Errors

Invalid configuration throws an `Error` with a `code`:

| `code`                | Cause                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `COMPATGATE_TARGETS`  | An invalid browserslist query or config (`TargetsConfigError` in JS).      |
| `COMPATGATE_ALLOW`    | An invalid `allow` entry, glob or `compatgate.jsonc` (`AllowConfigError`). |
| `COMPATGATE_INTERNAL` | A bug in compatgate. Please report it with the checked file.               |

An argument of a wrong type, such as a number for `source`, is a programming error. napi throws it
with its own code, such as `StringExpected`.

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
- **Prototype methods** by name, such as `.toSorted()`. These findings are heuristic: names that a supported
  method also has (`.map()`), names that the file declares as members itself (`class Q { union() {} }`,
  `class Q { take = 1 }`, accessors, `{ take() {} }`, `{ take: f }`, `obj.take = f`, `obj['take'] = f`)
  and calls on imported or required modules (`_.union()`) are skipped. A `require` result is skipped when
  `require` is the CommonJS global, a function parameter, a `declare`d `require`, or a variable that holds
  `createRequire(...)`, `module.createRequire(...)` or `__webpack_require__`.
  Transpiled wrappers such as `__importDefault(require('x'))`
  and `_interopRequireDefault(...)`, and `.default` of a module, are skipped too.
  When several methods share a name, the finding names the one with the worst support.
  Members of `DisposableStack` and `AsyncDisposableStack` are not checked as prototype methods:
  their names (`use`, `dispose`, `move`, `adopt`, `defer`) are also methods of Vue, express and three.js.
  Their constructors are still checked. Getters such as `description`, `detached` and `resizable`
  are never treated as methods.

Each finding has a confidence: `exact`, `heuristic` (a method found by name) or `partial`
(some targets support the feature only in part; `unsupported[].note` explains the limit). A heuristic
finding stays `heuristic` under partial support and keeps the note.

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
   | stored or passed              | `y = X`, `const y = X`, `f(X)`, `return X`, `{ a: X }`, `` `${X}` ``                                                                             | a finding, unless a check protects it            |

   `y = X` both passes the value on and stores it, and the worse result counts: `y = navigator.share;` is a
   finding, `(y = a || navigator.share)(d)` too.

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
   | `A && B`, `A \|\| B`                                                                                                       | both, what both prove                  | what both prove, both        |
   | `c ? A : B`                                                                                                                | what both `c && A` and `!c && B` prove | the same with `A`, `B` false |
   | `void 0`, `undefined`, `null`, `false`, `0`, `""`                                                                          | everything                             | nothing                      |
   | `true`, other numbers, other strings                                                                                       | nothing                                | everything                   |

   A test that never has a value proves everything there: that code never runs. So
   `if (c ? void 0 : navigator.share) navigator.share(d)` is protected.

   Minified forms such as `typeof X<"u"` and `void 0 !== window.X` count. A check proves `X` for uses of
   `X`, and `a.m` for calls `b.m()` of a method found by name. It also proves a use that every target
   version without full support of the use lacks `X` in: `if (window.navigation) navigation.navigate('/')`.
   The root of a chain is a use of its own: `navigation.currentEntry` reports `api.Window.navigation`,
   and the member only where the root does not cover its gap. When the member covers the gap of the root
   instead, the member reports both: `scheduler.yield()` is one finding, `api.Scheduler.yield`.

- A `try` with a `catch` protects whatever throws in its block in the same function, not in a callback
  or in the initializer of an instance field defined there: those run after the `try`.
- A value that passed `||`, `&&`, `??`, `?:` or `?.` is no finding where it escapes: `const f = a || navigator.share`
  is not a finding, `const f = navigator.share` is.
- Syntax is never protected: a file with it does not parse.
- A check on a shadowed local `window` or `Intl` does not protect uses of the global.
- A write that defines a global (`structuredClone = function () {}`) is not a use.
  Neither are a write through destructuring (`[window.X] = a`) and `delete window.X`.

## compatgate.jsonc

The file lists the features that you may use beyond your targets.
The linter and the bundler read the same file, so an entry works in both places.

```jsonc
{
  "extends": ["@company/compat-allow"],
  "allow": [
    // Closed by a core-js polyfill in the bundler
    "api.URLSearchParams.size",

    // Only for the code of these packages
    { "feature": "api.ResizeObserver", "packages": ["some-lib"] },

    // Only for these files, relative to this config
    { "feature": "api.ResizeObserver", "files": ["src/desktop/**"] },
  ],
}
```

`extends` takes a relative path, a package name (its `compatgate.jsonc`), or a `.jsonc` file
inside a package, such as `@company/compat-allow/strict.jsonc`.

A feature id is the full path of the feature in
[@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data).
Copy it from the message of a finding.

Do not suppress findings with linter comments such as `// oxlint-disable-next-line`.
The bundler checks the code after transpilation and does not see these comments,
so the linter passes and the build fails. Use `files` in `compatgate.jsonc` instead.
