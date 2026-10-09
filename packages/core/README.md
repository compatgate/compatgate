# @compatgate/core

Finds JavaScript syntax and APIs that your browserslist targets do not support.
It parses the source, compares what the code uses with browser compatibility data and returns findings.
Use it through `@compatgate/eslint` or `@compatgate/bundler`, or call it directly.

The core does not read files and has no linter or bundler logic. Adapters read the sources,
pass them in and show the findings.

## Quick start

```sh
npm install @compatgate/core
```

```js
import { check } from '@compatgate/core';

const result = check(source, { filename: '/project/src/app.ts' });
for (const finding of result.findings) {
  console.log(finding.feature, finding.start, finding.unsupported);
}
```

`check` finds the browserslist config and `compatgate.jsonc` above `filename`.
A linter or a bundler checks many files with one configuration. It creates a checker once:

```js
import { createChecker, loadAllow, resolveTargets } from '@compatgate/core';

const checker = createChecker({
  targets: resolveTargets('/project/src/index.ts'),
  allow: [...loadAllow('/project/src/index.ts').entries, 'api.structuredClone'],
});
const result = checker.check(source, '/project/src/app.ts');
```

## Configuration

### Targets

`targets` is a browserslist query. Without it, `check` finds the browserslist config above `filename`.
`defaultTargets` is the query to use when the project has no browserslist config.
`resolveTargets(filename, { defaultTargets })` gives the query that `check` would use.

### compatgate.jsonc

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

An `allow` entry is a feature id or an object with `feature`, `packages` and `files`.
The inline `allow` option takes the same entries. Pass `allow` to skip the lookup of `compatgate.jsonc`.
Relative `files` resolve against the `baseDir` of the entry. Without it, they resolve against
the `baseDir` option, then against the process directory.

Do not suppress findings with linter comments such as `// oxlint-disable-next-line`.
The bundler checks the code after transpilation and does not see these comments,
so the linter passes and the build fails. Use `files` in `compatgate.jsonc` instead.

## API

### createChecker(options)

```ts
createChecker({ targets: string, allow?: (string | AllowEntryInput)[], baseDir?: string }): Checker
```

The checker resolves the query, builds the support table and compiles the globs of `allow` once.
It never changes after `createChecker`, so workers can each hold a checker and check at the same time.

`allow` takes feature ids and entries in the form of `compatgate.jsonc`, plus an optional `baseDir`
for relative `files`. Without it, `files` resolve against the `baseDir` option, then against the process
directory.

### Checker.check(source, filename)

Checks one file and returns a `CheckResult`. `filename` selects the parser and matches the `files`
and `packages` of the entries.

### check(source, options)

```ts
check(source, { filename, targets?, defaultTargets?, allow?, allowFile?, baseDir? }): CheckResult
```

Finds the targets and `compatgate.jsonc` above `filename`, unless the options give them.
`allowFile` is the path of the allow config, used when `allow` is not given.
`check` keeps the checkers of the 16 most recently used configurations.

### isCheckable(filename)

Tells whether the extension selects a parser. See `parseError` below.

The filename must be a path. A bundler id such as `/src/a.ts?v=123` has a query: strip `?…` before
the call, as Vite's `cleanUrl` does. compatgate does not strip it itself: `?` and `#` are valid
in file names, and the `files` globs of `allow` match the same filename.

### normalizeAllowEntry(entry, baseDir)

Gives the form that `loadAllow` returns.

### validateAllow(allow, targets)

Reports entries with an unknown feature id and entries that the targets support natively.

### bcdVersion()

Returns the version of the compatibility data.

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

Each finding has a confidence: `exact`, `heuristic` (a method found by name) or `partial`
(some targets support the feature only in part; `unsupported[].note` explains the limit). A heuristic
finding stays `heuristic` under partial support and keeps the note.

An `allow` entry for the feature or for any of its `alternatives` suppresses a heuristic finding.

A source that does not parse is no error: the result has no findings and a `parseError`.
A linter shows its own parse errors, and a bundler skips the module. The kind `unsupported-file` means
that the extension selects no parser: `.vue`, `.css`, a file without an extension.
`isCheckable(filename)` tells it before the call.

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
  Module syntax is not checked: bundlers replace it.
- **Regular expressions**: lookbehind, named groups, modifiers, `\p{…}` and flags, in literals and in
  `RegExp()` with string arguments.
- **Builtins and Web APIs** reached as globals: `structuredClone()`, `new Intl.Segmenter()`, `Object.groupBy()`
  and members of singletons such as `navigator.userActivation`. `window.X`, `self.X` and `globalThis.X`
  count as the global `X`.
- **Prototype methods** by name, such as `.toSorted()`, `['toSorted']()` and `.toSorted.call(…)`. These
  findings are heuristic: the checker cannot know the type of the object, so it skips names that a
  supported method also has, names that the file declares itself and calls on imported modules. A name
  that another module declares still gives a finding. On a literal receiver, such as `[3, 1].toSorted()`
  or `new Set().union(b)`, the type is known and the finding is exact.

A use under a check of the same feature is not a finding: a use is no finding when the code drops
its value or when a check protects it.

```js
if ('Segmenter' in Intl) new Intl.Segmenter();
typeof structuredClone === 'function' ? structuredClone(value) : clone(value);
list.toSorted?.();
try {
  new RegExp('(?<=a)b');
} catch {}
```

Caveats:

- A bare global read such as `structuredClone;` that throws when the global is missing is a use.
  A member read such as `navigator.share` reads as `undefined`, and its parents decide what follows.
- Syntax is never protected: a file with it does not parse.
- A `try` with a `catch` protects whatever throws in its block in the same function, not in a callback.
- A `const` and a variable written once hold the value of their expression: `const s = navigator.share; if (s) s(d)`
  is protected, and so is the temporary variable of a downleveled `?.` inside a function or a module. At the top
  level of a classic script another script may write a `var`, so it is no alias there.
- A write that defines a global (`structuredClone = function () {}`) is not a use.
- Members of `DisposableStack` and `AsyncDisposableStack` are not checked as prototype methods:
  their names (`use`, `dispose`, `move`, `adopt`, `defer`) are also methods of Vue, express and three.js.
  Their constructors are still checked.

## How checks work

[docs/checks.md](docs/checks.md) has the full model: where a value goes, where a check holds,
what a check proves, and the details of each category.
