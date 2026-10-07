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
- **Prototype methods** by name, such as `.toSorted()`. These findings are heuristic: names that a supported
  method also has (`.map()`) and calls on imported or required modules (`_.union()`), including transpiled
  `require` wrappers, are skipped.

Each finding has a confidence: `exact`, `heuristic` (a method found by name) or `partial`
(some targets support the feature only in part; `unsupported[].note` explains the limit).

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
- A loose comparison with `null` is a check: `window.X != null`. A strict one, `window.X !== null`, is not:
  a missing member is `undefined`, not `null`.
- Reading a bare global such as `if (structuredClone)` is still a finding: it throws in browsers that lack it.
- Minified checks such as `typeof X<"u"` and `void 0 !== window.X` are recognized.
- A `try` protects a call or a constructor only when it has a `catch` and the call runs inside the `try` block,
  not in a callback defined there.
- Syntax is never protected by `try` or by an optional call.
- A write that defines a global (`structuredClone = function () {}`) is not a use.

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
