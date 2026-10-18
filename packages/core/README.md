# @compatgate/core

Finds JavaScript syntax and APIs that your browserslist targets do not support.
It parses the source, compares what the code uses with browser compatibility data and returns findings.
Use it through `@compatgate/eslint` or `@compatgate/bundler`, or call it directly.

The core does not read files and has no linter or bundler logic. Adapters read the sources,
pass them in and show the findings.

## Requirements

Node.js 22.12 or later. The package is ESM, and a CommonJS config loads it with `require`.

Native binaries cover macOS, Linux (glibc and musl) and Windows on x64 and arm64. On another platform, such as
FreeBSD or riscv64, install the WebAssembly build `@compatgate/core-wasm32-wasi`. Its `cpu` field is `wasm32`, so
a package manager may skip it on your CPU; with npm, run `npm install --cpu=wasm32`.

## Quick start

```sh
npm install @compatgate/core
```

```js
import { createResolver } from '@compatgate/core';

const resolver = createResolver({ extends: ['@company/compat-allow'], baseDir: '/project' });
const result = resolver.check(source, '/project/src/app.ts');
for (const finding of result.findings) {
  console.log(`${finding.start.line}:${finding.start.column} ${finding.message}`);
}
```

`createResolver` checks the options once. `check` finds the browserslist config and `compatgate.jsonc` above the
file and checks the text of the file. The core reads no files: the caller passes the text as `source`.

A project may hold several configs, such as a package of a monorepo with its own `.browserslistrc` or
`compatgate.jsonc`, so the lookup starts at the file. `baseDir` alone cannot tell which config applies. It is the
project root: relative paths resolve against it, it tells the project from its dependencies, and compatgate watches
it for a new config.

A linter or a bundler also needs the configuration of a file: its `allow` entries, their issues and the configs to
watch. It takes the configuration with `resolve` and checks with its checker:

```js
const filename = '/project/src/app.ts';
const { checker, issues, watch } = resolver.resolve(filename);
const result = checker.check(source, filename);
```

The configuration depends on the directory, not on the file, and compatgate computes it once per directory with
configs. So the files of a project share a few configurations and checkers. `check` of the checker takes the file
name again: it matches the `files` of the `allow` entries and selects the parser by the extension.

## Configuration

### Targets

`targets` is a browserslist query. Without it, compatgate finds the browserslist config above the file.
`defaultTargets` is the query to use when the project has no browserslist config. The `browserslist` package
resolves the query into browser versions, with its own data and its environment variables: `BROWSERSLIST`,
`BROWSERSLIST_CONFIG`, `BROWSERSLIST_ENV`. An error of browserslist, such as an unknown browser or
`.browserslistrc` next to a `browserslist` field of package.json, is a `TargetsConfigError` that names the config.

browserslist warns when its data is old: `Browserslist: browsers data (caniuse-lite) is N months old`. Babel and
Autoprefixer print the same warning. It shows once per process, and once more after each change of a watched
config: compatgate clears the caches of browserslist then, and browserslist checks its data again.
Update the data in the project with `npx update-browserslist-db@latest`: old data gives old versions to `defaults`
and `last 2 versions`, and compatgate checks against them.

A shared config in `extends` resolves as in browserslist: from the process directory, then from the checked file.
For a file inside `node_modules` the second place is the project side: see below. browserslist takes only the
names of shared configs: a package `browserslist-config-*` or `@scope/browserslist-config*`, or a file inside it.
Another name, such as a relative or an absolute path, is a `TargetsConfigError`, and the module does not load.
`BROWSERSLIST_DANGEROUS_EXTEND=1` turns the rule off.

### Configs of dependencies

A file inside `node_modules` takes the configs of the project: the browserslist config and `compatgate.jsonc`.
The lookup starts in the directory above the outermost `node_modules`, so a package of pnpm
(`node_modules/.pnpm/lib@1.0.0/node_modules/lib`) takes them too. The project builds the dependency for its own
targets, and an entry with `packages: ["lib"]` in the project config applies to it. The configs that a
dependency ships do not apply.

A `node_modules` directory that holds the project root does not count, so a project that lies inside
`node_modules` keeps its own configs. The root is the `baseDir` option; the default is the process directory.

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

The `extends` option takes the same values. A tool passes its own base list there, such as the features that its
polyfills close. The entries of the base come first, then the entries of `compatgate.jsonc` or of the `allow`
option. Without `compatgate.jsonc` the base applies alone. A project adds entries to the base, but cannot remove
them. A package name and a relative path in the `extends` option resolve against `baseDir`.

A feature id is the full path of the feature in
[@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data).
Copy it from the message of a finding.

An `allow` entry is a feature id or an object with `feature`, `packages` and `files`.
The inline `allow` option takes the same entries. Pass `allow` to skip the lookup of `compatgate.jsonc`.
Relative `files` resolve against the `baseDir` of the entry. Without it, they resolve against
the `baseDir` option, then against the process directory.

### Changes to the configs

compatgate watches the configs that it has read. These are each `compatgate.jsonc` with the files of its
`extends`, the files of the `extends` option, and the browserslist config that applies: `.browserslistrc`,
`browserslist`, the package.json whose field it uses, or the file of `BROWSERSLIST_CONFIG`. When the lookup of a
file reaches the project root, the `baseDir` option, compatgate also watches the places of a new config there:
`.browserslistrc`, `browserslist`, `package.json` and `compatgate.jsonc`. An existing package.json of the root is
watched too, as it may get the `browserslist` field.

One rule applies to all of them. A change of any watched file, an edit, a deletion or a new file, drops every
cached configuration, config and checker, and the caches of browserslist. The next calls compute again. A call of
`resolve` checks the modification time and size of the watched files: without the `snapshot` option at most once in
250 ms per process, with it once per snapshot. So the changes show in an IDE and
in watch mode without a restart. `clearCaches()` drops every cache at once.

A new config in another directory, below the project root or above it, shows after a restart or `clearCaches()`.
So does a `browserslist` field added to a package.json in another directory. Only the places of the root are
watched: each module of a bundler registers them, and the places of every directory on the way made an rspack
build of 16 731 modules about 0.06 s slower.

An edit inside a shared config of browserslist `extends` shows after a restart: Node.js keeps the loaded
package. The `BROWSERSLIST` and `BROWSERSLIST_CONFIG` variables replace the lookup, so the places of a
browserslist config do not apply with them.

## API

### createResolver(options)

```ts
createResolver({ targets?, defaultTargets?, allow?, extends?, baseDir?, where? }): Resolver

interface Resolver {
  resolve(filename: string, options?: { snapshot?: object }): Configuration;
  check(source: string, filename: string, options?: { parseAs?: string; snapshot?: object }): CheckResult;
  displayPath(path: string): string;
}
```

Checks the options and gives a resolver of the configurations. An unknown option or an option of a wrong type is an
`OptionsError` that names the option, such as `settings.compatgate.targets: expected a string`, so an adapter makes
the resolver when it reads its options and the error shows at once, not at the first file.

`where` names the options in messages, such as `settings.compatgate`: an error names `settings.compatgate.targets`
or `settings.compatgate.allow[0]`, and an inline entry has `source.options` `settings.compatgate`. The default is
`options`: `options.targets`, `options.allow[0]`.

`resolve(filename, options?)` gives the configuration of a file: how to check it. `snapshot` is an object that
stands for one build. The first call with a snapshot checks the watched configs, and the other calls with it do
not: a change in the middle of a build shows in the next build. A bundler passes a new object at the start of each
build. Without `snapshot` a call checks the configs at most once in 250 ms: see "Changes to the configs".

`check(source, filename, options?)` checks one file with the checker of `resolve(filename, options)`. The indexes
of `suppressed` point into the `entries` of that configuration. `parseAs` selects the parser instead of `filename`:
see "Checker".

`displayPath(path)` names a path as the messages of compatgate name it: relative to `baseDir` with `/` separators
when it lies below it, as it is otherwise. An adapter names the paths of its own messages with it.

### checkOptions(value, schema, where, settings?)

```ts
checkOptions(value: unknown, schema: OptionSchema, where: string, settings?: CheckOptionsSettings): void

type OptionSchema = Record<string, [test: (value: unknown, where: string) => boolean, expected: string]>;
const SHARED_SCHEMA: OptionSchema; // targets, defaultTargets, allow, extends
```

Checks an object of options against a schema, as the core checks compatgate.jsonc and its entries: each key is
known and each value passes its test. An adapter adds its own keys to the shared ones, so a typo fails in the same
words everywhere: `{ ...SHARED_SCHEMA, syntax: [value => typeof value === 'boolean', 'a boolean'] }`. An unknown
key is `<where>: unknown key "x". Known keys: …`, a value of a wrong type is `<where>.<key>: expected …`, and a key
set to `undefined` counts as absent. A key `__proto__`, which JSON turns into the prototype of the object, is an
unknown key. Throws `OptionsError`; `settings.error` gives another class.

### Configuration

```ts
interface Configuration {
  targets: string; // the browserslist query
  entries: AllowEntry[]; // the entries of `extends`, then of `allow` or of compatgate.jsonc
  checker: Checker;
  issues: AllowIssue[]; // entries with an unknown feature id or a feature of every target
  ignoredBrowsers: string[]; // browserslist names without compatibility data
  watch: string[]; // the configs that the configuration comes from, and the package.json of the root
  missing: string[]; // the places in the project root of a config that would apply instead or conflict
}
```

The configuration and its arrays are frozen. Directories with the same configs share the `entries` list and the
`checker`.

Each entry has an `origin` and a `source`. compatgate sets both; an entry of the options may not set them.

```ts
interface AllowEntry {
  feature: string;
  packages: string[];
  files: string[];
  baseDir: string; // the directory that `files` resolve against
  origin: 'own' | 'inherited';
  source: { file: string; index: number } | { options: string; index: number };
}
```

`origin` is `own` for the `allow` of `compatgate.jsonc` or of the options, `inherited` for the entries of
`extends`. A report of unused entries covers the own entries only: a shared base list is wider than any project.
`source` is the place of the entry: the config file and the index in its `allow`, or the `where` of the options and
the index in the `allow` option.

`issues` reports the entries with an unknown feature id and the entries that every target supports:

```ts
interface AllowIssue {
  index: number; // the index of the entry in `entries`
  kind: 'unknown-feature' | 'native-in-targets';
  suggestion?: string; // the closest known id for an unknown one
  message: string;
}
```

`suggestion` is the id with `_static`, as BCD names static members, or a sibling a few edits from the last segment,
such as `api.fetch` for `api.fetchh`. A mistyped parent segment is corrected the same way: `api.URl.canParse` gives
`api.URL.canParse_static`. A segment below six characters allows one edit, a longer one two; a swap of adjacent
characters is one edit.

`message` is the same in the linter and in the bundler. It names the place of the entry, relative to `baseDir`:

```text
compatgate.jsonc, allow[3]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".
settings.compatgate.allow[0]: every target browser supports "api.fetch". Remove the entry.
compatgate.jsonc, allow[4]: unknown feature "api.URL.canParse". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone". Did you mean "api.URL.canParse_static"?
```

An inherited entry gets no fix: compatgate ignores its unknown id, and its feature of every target has no effect. A
base list shared by many projects may name a feature of a newer compatgate, and the project may not own the base.

`ignoredBrowsers` names the browsers of the targets that compatgate has no data for. BCD has no data for some
browsers by definition, and `ignoredBrowsers` leaves them out: `op_mini` (Opera Mini), `and_uc` (UC Browser for
Android), `and_qq` (QQ Browser for Android) and `kaios` (KaiOS Browser). The query `defaults` selects them. Other
browsers without data, such as `ie`, stay in the list.

### Watching the configs

`watch` and `missing` serve a tool that runs for a long time, such as a bundler in watch mode. `watch` lists the
configs that the configuration comes from: an edit of one changes the configuration. `missing` lists the places in
the project root where a new config would apply. The tool passes them to its own watcher, as webpack takes
`addDependency` and `addMissingDependency`. Then an edit or a new config starts a new check. A config error has
`watch` and `missing` too: see "Errors".

### Checker

`check(source, filename, parseAs?)` checks one file and returns a `CheckResult`. The indexes of `suppressed` point
into the `entries` of the configuration. `filename` matches the `files` and `packages` of the entries and selects
the parser. `parseAs` is a name whose extension selects the parser instead: a bundler checks the script of
`/src/App.vue` with `parseAs` `/src/App.vue.ts`, and `files: "src/*.vue"` still matches it.

### isCheckable(filename)

Tells whether the extension selects a parser. See `parseError` below.

The filename must be a path. A bundler id such as `/src/a.ts?v=123` has a query: strip `?…` before
the call, as Vite's `cleanUrl` does. compatgate does not strip it itself: `?` and `#` are valid
in file names, and the `files` globs of `allow` match the same filename.

### clearCaches()

Drops every cached configuration, config and checker. See "Changes to the configs".

### bcdVersion()

Returns the version of the compatibility data.

### Result

```ts
interface CheckResult {
  findings: Finding[];
  suppressed: { index: number; kind: 'syntax' | 'builtin' | 'api' }[]; // see below
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
  message: string;
}
```

`message` is the same in the linter and in the bundler:

```text
javascript.builtins.Intl.Segmenter is not supported in Safari 15.6 (since 16.4), Safari on iOS 15.5 (since 16.4).
Check the feature in code, or add "javascript.builtins.Intl.Segmenter" to compatgate.jsonc.
```

The message is one line; it is wrapped here. A partial finding gives the BCD notes, and a heuristic finding names
its alternatives. Browsers have the names of the compatibility data, such as `Safari on iOS`. The advice names the
place of the entries of the project: its compatgate.jsonc relative to `baseDir`, or the option, such as
`settings.compatgate.allow`. Without either it names `compatgate.jsonc`.

`suppressed` tells, for each `allow` entry that silenced a finding, which kind of finding it silenced. An entry
that silenced findings of two kinds has two items. The items go by the index of the entry, then by the kind
(`syntax`, `builtin`, `api`). An adapter that wants the entries that the file uses takes the unique indexes.
A bundler that lowers the syntax after the check uses the kind: an entry that silenced syntax only may be
needed by none of the code in the bundle.

Lines start at 1, columns at 0. Columns and `range` count UTF-16 code units, as JavaScript strings do.
`source.slice(...range)` is the code of the finding. Columns skip a byte order mark, as ESLint does;
`range` counts it.
A syntax finding covers the token of the feature, such as `static` or `??=`, not the whole class or
expression: [docs/syntax-ranges.md](docs/syntax-ranges.md) lists the token of each feature.

Each finding has a confidence: `exact`, `heuristic` (a method found by name) or `partial`
(some targets support the feature only in part; `unsupported[].note` explains the limit). A heuristic
finding stays `heuristic` under partial support and keeps the note.

An `allow` entry for the feature or for any of its `alternatives` suppresses a heuristic finding.

A source that does not parse is no error: the result has no findings and a `parseError`.
A linter shows its own parse errors, and a bundler skips the module. The kind `unsupported-file` means
that the extension selects no parser: `.vue`, `.css`, a file without an extension.
`isCheckable(filename)` tells it before the call.

### Errors

An error of compatgate has a `code`. Invalid configuration throws a `ConfigError`, and its subclass tells the
cause:

| `code`                | Class                | Cause                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------ |
| `COMPATGATE_TARGETS`  | `TargetsConfigError` | An invalid browserslist query or config.                     |
| `COMPATGATE_ALLOW`    | `AllowConfigError`   | An invalid `allow` entry, glob or `compatgate.jsonc`.        |
| `COMPATGATE_OPTIONS`  | `OptionsError`       | An option of a wrong type.                                   |
| `COMPATGATE_INTERNAL` | `Error`              | A bug in compatgate. Please report it with the checked file. |

The message names a config inside `baseDir` by its path relative to `baseDir`, as the messages of findings and
entries do: `compatgate.jsonc: unknown key "alow"`. A config outside `baseDir` keeps its absolute path. The fields of
an error keep absolute paths.

An `AllowConfigError` has `path`: the config file to fix. It is the file with the error, a file of `extends`
included, or the config whose `extends` names a missing file. It is `undefined` for inline entries, for the
`extends` option and for an invalid glob. A `TargetsConfigError` has `directory` when browserslist names the
directory of the failing config, as in a conflict of two configs.

A config error of `resolve` also has `watch` and `missing`: the configs whose edit or
appearance may fix it. A bundler watches them, so a fix starts a new check. Targets without a browser with data and
an invalid glob fail in the native checker: the error has the error of the checker as its `cause`, and its `watch`
lists every config of the configuration.

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
