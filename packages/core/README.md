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
  `createRequire(...)` or `__webpack_require__`. Transpiled wrappers such as `__importDefault(require('x'))`
  and `_interopRequireDefault(...)`, and `.default` of a module, are skipped too. When several methods share a name, the finding names the one
  with the worst support.
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

Rules for checks:

- A member read is a check only when it is the tested value itself: `if (navigator.userActivation)`.
  Reading something from it, as in `if (navigator.userActivation.isActive)`, is a finding.
- Optional chaining on the member is a check: `navigator.userAgentData?.brands`.
  In `navigator.userAgentData.brands?.length` the optional access comes too late, so it is a finding.
  In a test, `X?.y` is a check too: `if (navigator?.userActivation)`.
- In a test (`if`, `?:`, `&&`, `||`), a member compared with anything (`===`, `!==`, `==`, `!=`)
  is read as a check. Outside a test, `const ok = window.X !== undefined` is a finding.
- Of the comparisons with a value, only those that rule out `undefined` protect the code that follows:
  `!= null`, `!= undefined`, `!== undefined` and `!== void 0`, in either order. A strict `!== null` does not:
  `if (window.structuredClone !== null) structuredClone(1)` still reports the call,
  because a missing member is `undefined`, not `null`.
- Other forms that protect: `'X' in obj`, truthiness, `typeof X !== 'undefined'`,
  `typeof X === 'function'` and `typeof X === 'object'`.
- Method checks match by name on any object: `if (list.toSorted) other.toSorted()` is protected,
  because methods are found by name.
- Reading a bare global such as `if (structuredClone)` is still a finding: it throws in browsers that lack it.
- Minified checks such as `typeof X<"u"` and `void 0 !== window.X` are recognized.
- A `try` protects a call or a constructor only when it has a `catch` and the call runs inside the `try` block,
  not in a callback defined there.
- Syntax is never protected by `try` or by an optional call.
- Calls through wrappers, `(0, window.X)()` and `(window.X as any)()`, are calls.
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
