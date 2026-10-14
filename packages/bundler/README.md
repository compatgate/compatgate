# @compatgate/bundler

A bundler plugin that finds JavaScript APIs and syntax that your browserslist targets do not support.
It runs in webpack, rspack, Vite, Rollup, Rolldown and esbuild through [unplugin](https://unplugin.unjs.io).

The plugin checks each module after the other transforms: it sees the code that goes into the bundle, after the
transpiler has lowered the syntax it can lower. So a class static block that SWC or Babel lowers is no finding,
while a lookbehind assertion in a regular expression, which no transpiler lowers, is. The plugin does not change
the code.

## Install

```sh
npm install --save-dev @compatgate/bundler
```

The package is ESM. A CommonJS config, such as `webpack.config.js`, loads it with `require`
(Node.js 20.19, 22.12 and later).

## Set up

### webpack and rspack

```js
// webpack.config.js
const { compatgateWebpack } = require('@compatgate/bundler');

module.exports = {
  plugins: [compatgateWebpack()],
};
```

rspack takes `compatgateRspack()` the same way.

### Vite

```js
// vite.config.js
import { compatgateVite } from '@compatgate/bundler';

export default { plugins: [compatgateVite()] };
```

The plugin checks the modules of the client environments only: a server environment, such as SSR, runs in
Node.js. Vitest runs the plugins of `vite.config.js` on the test files too. To keep compatgate out of the tests,
apply it to the build only, or skip it under Vitest:

```js
export default {
  plugins: [{ ...compatgateVite(), apply: 'build' }],
  // or: plugins: [process.env.VITEST ? null : compatgateVite()],
};
```

### Rollup and Rolldown

```js
// rollup.config.js
import { compatgateRollup } from '@compatgate/bundler';

export default { input: 'src/index.js', plugins: [compatgateRollup()] };
```

Rolldown takes `compatgateRolldown()` the same way. Put compatgate after the plugins that transform the code,
such as a TypeScript plugin: Rollup and Rolldown run the plugins in the order of the array.

### esbuild

```js
import { build } from 'esbuild';
import { compatgateEsbuild } from '@compatgate/bundler';

await build({ entryPoints: ['src/index.js'], bundle: true, plugins: [compatgateEsbuild()] });
```

Put compatgate after every plugin that loads `.js` or `.ts` files. In esbuild the plugin loads the file itself,
and a plugin after it would never load the file. See [docs/hosts.md](docs/hosts.md#esbuild).

`compatgate` is the unplugin instance itself: `compatgate.webpack(options)`, `compatgate.vite(options)`
and so on.

Each bundler also has a subpath whose default export is its plugin, as unplugin advises:
`@compatgate/bundler/vite`, `/webpack`, `/rspack`, `/rollup`, `/rolldown` and `/esbuild`.

```js
// vite.config.js
import compatgate from '@compatgate/bundler/vite';

export default { plugins: [compatgate()] };
```

A CommonJS config takes the default export by its name: `require('@compatgate/bundler/webpack').default`.

## Options

All options are optional.

| Option           | Meaning                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `targets`        | A browserslist query. Default: the browserslist config of each module.                                 |
| `defaultTargets` | The query for a module without a browserslist config. Default: `defaults`.                             |
| `allow`          | Allow entries, as in `compatgate.jsonc`. They replace the lookup of `compatgate.jsonc`.                |
| `extends`        | Base configs, as `extends` of `compatgate.jsonc`: paths of `.jsonc` files or package names.            |
| `include`        | Modules to check. Default: every JavaScript and TypeScript module.                                     |
| `exclude`        | Modules to skip.                                                                                       |
| `severity`       | The level of each confidence: `{ exact?, heuristic?, partial? }`, each `'error'`, `'warn'` or `'off'`. |

```js
compatgateWebpack({
  extends: ['@company/compat-allow'],
  exclude: ['**/*.test.ts'],
  severity: { heuristic: 'off' },
});
```

- `extends` is a base list that a tool passes for every project. The build tool of a company closes some
  features with its polyfills and passes that list here. Without the option every project would write
  `"extends": [...]` in its own `compatgate.jsonc`. Its entries come first; a project can only add entries to
  them. Pass the same list to the `extends` setting of `@compatgate/eslint`, so the linter sees the same base
  list as the build.
- `allow` is for a build without `compatgate.jsonc`. Most projects leave it out and keep the entries in
  `compatgate.jsonc`, where the linter reads them too.
- `include` and `exclude` take a glob, a regular expression or an array of them. They match the path of the
  module without the query, with `/` separators. `exclude` wins over `include`.
- Relative paths resolve against the project root: `context` in webpack and rspack, `root` in Vite, `cwd` in
  Rolldown, `absWorkingDir` in esbuild, the process directory in Rollup.
- An unknown option or a value of a wrong type is an `OptionsError` of `@compatgate/core` with the code
  `COMPATGATE_OPTIONS`. The message names the option: `compatgate.severity.exact: expected "error", "warn" or "off"`.

## Severity

The core gives each finding a confidence:

| Confidence  | Finding                                                                              | Default |
| ----------- | ------------------------------------------------------------------------------------ | ------- |
| `exact`     | A feature that the code uses for sure, such as `structuredClone(…)`.                 | `error` |
| `heuristic` | A method found by its name on an object of unknown type, such as `items.toSorted()`. | `warn`  |
| `partial`   | A feature that some targets support only in part, with the limits of the BCD notes.  | `warn`  |

A finding of level `error` fails the build, and a finding of level `warn` is a warning of the build.
One build shows all findings. In the dev server of Vite a module with an error fails, and the server goes on
serving the other modules. [docs/hosts.md](docs/hosts.md#how-a-build-fails) describes each bundler.

```js
compatgateWebpack({ severity: { exact: 'warn' } }); // report, but do not fail the build
```

## Exceptions belong in compatgate.jsonc

The plugin takes the browserslist config and `compatgate.jsonc` above each module. Add a feature that you may
use beyond your targets to `compatgate.jsonc`. The `files` and `packages` of an entry limit it to some files or
packages:

```jsonc
{
  "allow": [
    // Closed by a core-js polyfill in the build
    "api.URLSearchParams.size",
    // Only the code of this package
    { "feature": "api.ResizeObserver", "packages": ["some-lib"] },
  ],
}
```

`@compatgate/eslint` reads the same file, so an entry works in both places. To protect one call, check the
feature in code, such as `if (typeof structuredClone === 'function')`. The README of `@compatgate/core`
describes `compatgate.jsonc` in full.

## What to expect

A finding shows its confidence, the module, the position and the message of the core:

```text
[compatgate/exact] src/split.ts:6:11: javascript.builtins.Intl.Segmenter is not supported in Firefox 115 (since 125). Check the feature in code, or add "javascript.builtins.Intl.Segmenter" to compatgate.jsonc.
```

- **Confidence.** The label `[compatgate/exact]`, `[compatgate/heuristic]` or `[compatgate/partial]` names
  the key of `severity` that sets the level of the finding. The rules of `@compatgate/eslint` have the same
  names. The other messages of the plugin, such as the errors of a config, start with `[compatgate]`.
- **Advice.** The message advises to add the feature to the place of your entries: the nearest `compatgate.jsonc`
  of the module, or `compatgate.allow` when you pass `allow`.
- **Positions.** The position is in the source file. The plugin maps it back through the source map of the
  loaders or plugins before it. webpack and rspack give that map only when the build makes source maps: set
  `devtool`. A module without a map shows the position in the checked code, with the note
  `(position in the transpiled module)`.
- **Partial findings.** One partial feature can be in hundreds of places, mostly in `node_modules`. At the end of
  a build the warnings of one partial feature become one warning with the number of places and the first five:

  ```text
  [compatgate/partial] api.BarcodeDetector.BarcodeDetector in 7 places, the first 5: src/a.ts:1:5, src/a.ts:2:5, src/a.ts:3:5, src/a.ts:4:5, src/b.ts:1:5. api.BarcodeDetector.BarcodeDetector is only partially supported in Chrome 97 (no full support in any version). Chrome 97: Supported on ChromeOS and macOS only. If the limits do not affect this code, add "api.BarcodeDetector.BarcodeDetector" to compatgate.jsonc.
  ```

  A feature in one place keeps its usual message. The summary needs a record of every checked module of the
  build, as the report of unused entries does. A watch rebuild has them; the first build of a process with the
  persistent cache, and the dev server of Vite, show the partial findings one by one. esbuild shows them one by
  one too. A partial finding of the level `error` is an
  error one by one. The summary has no module: a filter of warnings by the module, such as `ignoreWarnings`
  with `module` of webpack or `warning.id` in `onwarn` of Rollup, does not match it. Use the `include` and
  `exclude` options, or match the message: `/compatgate\/partial/`. See
  [docs/hosts.md](docs/hosts.md#partial-findings).

- **Checked modules.** JavaScript and TypeScript modules, in your code and in `node_modules`, and the scripts of
  `.vue`, `.svelte` and `.astro` components. A module that the core cannot parse, such as Flow code, gives a
  warning, and the build goes on.
- **Configs.** A module in `node_modules` takes the configs of the project. The bundler watches the configs: an
  edit checks the modules again in watch mode and in the dev server. An error in a config is an error of the
  build.
- **Unused allow entries.** At the end of a build the plugin lists the entries of the project that suppressed no
  finding. It also reports unknown feature ids and entries for a feature that every target supports:

  ```text
  [compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "api.Highlight". Remove them unless other code needs them
  ```

  The entries of `extends` are left out. A watch rebuild reports too: the plugin keeps a record of each module as
  long as the plugin, not one build. The first build with the persistent cache has no list of unused entries.
  The entries of a config that the build read in two versions where an index names another feature are not
  reported either.

- **Syntax that the bundler lowers.** Vite, Rolldown and esbuild lower the syntax after the plugins. There the
  plugin lowers a module with a syntax finding the same way and checks it again, so a feature that the bundle
  will not have is no finding.
- **Cost.** On a service of 16 731 modules the plugin adds about 0.43 s to a 4.20 s production build of rspack
  (median of five series, +0.39…+0.53 s), and about 180 ms to a Vite build of 3 101 modules. See
  [docs/performance.md](docs/performance.md).

## More

- [docs/hosts.md](docs/hosts.md): how each bundler runs the plugin, fails a build and maps positions.
- [docs/model.md](docs/model.md): the rules of the plugin in four tables, and the properties of each bundler.
- [docs/configs.md](docs/configs.md): which modules are checked, which configs apply, how edits are watched.
- [docs/allow-report.md](docs/allow-report.md): the report of allow entries, and when a build has none.
- [docs/lowering.md](docs/lowering.md): how the plugin lowers syntax in Vite, Rolldown and esbuild.
- [docs/performance.md](docs/performance.md): what the plugin does with a module, and the measurements.
