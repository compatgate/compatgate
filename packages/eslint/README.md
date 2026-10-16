# @compatgate/eslint

ESLint rules that find JavaScript APIs and syntax that your browserslist targets do not support.
The same plugin runs in oxlint as a JS plugin. The rules call `@compatgate/core`: it parses the file,
compares what the code uses with browser compatibility data and returns findings.

## Requirements

- Node.js 22.12 or later. The packages are ESM, and a CommonJS config loads them with `require`.
- ESLint 9 or 10, or oxlint 1 with JS plugins.

## Install

```sh
npm install --save-dev @compatgate/eslint
```

## Set up

### ESLint

ESLint 9 and 10, flat config:

```js
// eslint.config.js
import compatgate from '@compatgate/eslint';

export default [
  compatgate.configs.recommended,
  {
    settings: {
      compatgate: { defaultTargets: 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115' },
    },
  },
];
```

Or set the rules yourself:

```js
export default [
  {
    plugins: { compatgate },
    rules: { 'compatgate/exact': 'error', 'compatgate/heuristic': 'warn', 'compatgate/partial': 'warn' },
  },
];
```

### oxlint

oxlint 1.85 and later, `jsPlugins`. oxlint does not read the `configs` of a plugin: list the rules.
The alias gives the rules the names that ESLint uses. Without it, the names are `@compatgate/eslint/exact` and so on.

```jsonc
// .oxlintrc.json
{
  "jsPlugins": [{ "name": "compatgate", "specifier": "@compatgate/eslint" }],
  "rules": { "compatgate/exact": "error", "compatgate/heuristic": "warn", "compatgate/partial": "warn" },
  "settings": {
    "compatgate": { "defaultTargets": "Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115" },
  },
}
```

## Rules

The core gives each finding a confidence. Each rule reports the findings of one confidence, so each
confidence has its own severity. `configs.recommended` makes `exact` an error and the others warnings.

| Rule        | Reports                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `exact`     | A feature that the code uses for sure, such as `structuredClone(…)` or `Object.groupBy(…)`.    |
| `heuristic` | A method that is found by its name on an object of unknown type, such as `items.toSorted()`.   |
| `partial`   | A feature that some targets support only in part. The message gives the notes of the BCD data. |

An IDE shows a link next to each message: `meta.docs.url` of the rule names its section below.

### `exact`

The code uses the feature for sure: a global such as `structuredClone`, a static method such as
`Object.groupBy`, a constructor such as `new Intl.Segmenter()`. Check the feature in code, use another way,
or add the feature to `compatgate.jsonc` when a polyfill closes it.

### `heuristic`

A method call on an object whose type the core does not know: `items.toSorted()` may be a call of
`Array.prototype.toSorted` or of a method of your own. The message names the other features of the same
name. Add the feature to `compatgate.jsonc` when the object is not of that type.

### `partial`

Some targets support the feature, but with the limits of the BCD notes, such as a bug of one version. The
message gives the notes. A check in code does not help: the feature is there. Add the feature to
`compatgate.jsonc` when the limits do not affect your code.

## Settings

The three rules share `settings.compatgate`. The rules have no options of their own.

| Key              | Value                            | Default                                          |
| ---------------- | -------------------------------- | ------------------------------------------------ |
| `targets`        | browserslist query               | the browserslist config above the file           |
| `defaultTargets` | browserslist query               | `defaults`; used when no config is found         |
| `allow`          | array of feature ids and entries | the entries of `compatgate.jsonc` above the file |
| `extends`        | array of paths and package names | none                                             |
| `syntax`         | boolean                          | `false`                                          |

```js
settings: {
  compatgate: {
    defaultTargets: 'Chrome >= 97, Safari >= 15.6',
    extends: ['@company/compat-allow'],
  },
},
```

- `allow` takes the entries of `compatgate.jsonc`: a feature id or `{ feature, packages?, files? }`.
  With `allow`, the rules do not look for `compatgate.jsonc`. Most projects leave it out and keep the entries
  in `compatgate.jsonc`, where the bundler reads them too.
- `extends` is a base list that a tool passes for every project. The build tool of a company closes some
  features with its polyfills and passes that list to `@compatgate/bundler` in its `extends` option. The shared
  lint config of the company passes the same list here, so the linter sees the same base list as the build.
  Without the setting every project would write `"extends": [...]` in its own `compatgate.jsonc`. The setting
  takes the values of `extends` in `compatgate.jsonc`. Its entries come first, then the entries of the project.
- `syntax: true` reports syntax in the linter too. See [What to expect](#what-to-expect).
- Relative paths in `extends` and the `files` of `allow` resolve against the cwd of the linter.

## Exceptions belong in compatgate.jsonc

Do not suppress findings with comments such as `// eslint-disable-next-line compatgate/exact`.
`@compatgate/bundler` checks the code after transpilation and does not see these comments,
so the linter passes and the build fails. Add the feature to `compatgate.jsonc` instead.
The `files` and `packages` of an entry limit it to some files or packages:

```jsonc
{
  "allow": [
    // Closed by a core-js polyfill in the build
    "api.URLSearchParams.size",
    // Only the desktop code uses it
    { "feature": "api.ResizeObserver", "files": ["src/desktop/**"] },
  ],
}
```

To protect one call, check the feature in code, such as `if (typeof structuredClone === 'function')`.
The linter and the bundler both recognize the check. The README of `@compatgate/core` describes
`compatgate.jsonc` in full.

## What to expect

The message names the feature, the targets without support and the first version with support:

```text
api.structuredClone is not supported in Chrome 97 (since 98).
Check the feature in code, or add "api.structuredClone" to compatgate.jsonc.
```

The message is one line; it is wrapped here. The advice names the place of your entries: the nearest
`compatgate.jsonc` of the file, or `settings.compatgate.allow` when the settings give `allow`.

- **Syntax is off by default.** The linter sees the source, and the transpiler of the build lowers syntax such
  as class fields or `??=` later. The bundler finds the syntax that the transpiler did not lower. Syntax that
  no transpiler lowers, such as a lookbehind assertion, then shows in the build only. Set `syntax: true` to see
  it in the IDE too.
- **Configs.** The rules take the browserslist config and `compatgate.jsonc` above each file. A file inside
  `node_modules` takes the configs of the project. An edit of `compatgate.jsonc` or of the browserslist config
  shows in an IDE without a restart. `eslint --cache` does not see an edit of these configs: delete the cache file
  after one.
- **Errors.** An error of a config, such as an invalid query or an unknown feature id in the entries of the
  project, is a message of the `exact` rule at the start of each file. The other rules and files are checked.
  A setting of a wrong type or an unknown key fails the rule: it is an `OptionsError` of `@compatgate/core` that
  names the key, such as `settings.compatgate.targets: expected a string`. An unknown feature id in a base list
  of `extends` is a process warning.
- **Not checked.** Vue and Svelte components are checked only by `@compatgate/bundler`. A source with a syntax
  error gives no messages: the parser of the linter reports the error itself.
- **Cost.** On a service of 16 289 files oxlint takes 0.68 s with the plugin and 0.36 s without it, about 20 µs
  per file. In ESLint the plugin adds about 70 µs per file. See [docs/performance.md](docs/performance.md).

## More

- [docs/configs.md](docs/configs.md): which configs apply to a file, code blocks of processors, edits and
  caches, errors in the settings and in the configs.
- [docs/performance.md](docs/performance.md): how the rules read a file, and the measurements.
