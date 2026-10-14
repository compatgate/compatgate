# Bundlers

This page describes how each bundler runs the plugin, fails a build, shows the position of a finding and sums up
the partial findings. The [README](../README.md) has the short version. The [table of hosts](model.md#hosts) gives
the properties of each bundler in one place; this page gives what the table does not: how and why.

## When the plugin runs

The plugin checks each module after the other transforms (`enforce: 'post'`). It sees the code that goes into
the bundle, after the transpiler has lowered the syntax it can lower. Rollup, webpack and rspack have no
lowering of their own: the transpiler is a plugin or a loader before compatgate, and the plugin sees its result.
Vite, Rolldown and esbuild lower the syntax after the plugins: see [lowering.md](lowering.md).

In Vite the plugin checks the modules of the client environments only. A server environment, such as SSR, runs
the code in Node.js, not in the browsers of the targets.

## esbuild

esbuild has no transforms of plugins: the first plugin whose `onLoad` gives the contents of a file loads it.
The plugin loads `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and `.tsx` files, checks the text of the
file and gives it to esbuild unchanged, with the loader of the `loader` option of the build or of the
extension. Put compatgate after every plugin that loads `.js` or `.ts` files: a plugin after it would never
load them, and compatgate does not check the files that an earlier plugin loads. Components (`.vue`, `.svelte`)
stay for the plugin of their framework and are not checked.

## How a build fails

A finding of level `error` fails the build, and a finding of level `warn` is a warning of the build.
One build shows all findings:

- In webpack and rspack each error is an error of its module: the build goes on, and at the end it fails with
  every error in `stats.errors`.
- In Rollup, Rolldown, esbuild and the build of Vite the plugin collects the errors, and at the end of the
  build it throws one error with all of them:

  ```text
  compatgate found 2 errors:
  [compatgate/exact] src/split.ts:6:11: javascript.builtins.Intl.Segmenter is not supported in Firefox 115 (since 125). …
  [compatgate/exact] src/match.ts:3:37: javascript.regular_expressions.lookbehind_assertion is not supported in Safari 15.6 (since 16.4), …
  ```

  When the build of Rollup, Rolldown or Vite fails for another reason, its own error stays, and the errors of
  compatgate are a warning. esbuild shows both errors: it gives the end of a build no error of its own.

- In the dev server of Vite a module with an error fails: the server answers its request with the error,
  and the overlay shows it. The server goes on serving the other modules.

Vite, Rollup, Rolldown and esbuild throw an `OptionsError` when the plugin is created, webpack and rspack when
the compiler applies the plugin. An option set to `undefined` takes its default. An inline `allow` entry may not
set `origin` or `source`: compatgate sets them, and the key is a config error of the build.

## Positions

The position is a line and a column, both from 1, in the source file. The plugin maps a finding through the
source map of the loaders or plugins before it; the [table of hosts](model.md#hosts) names the map of each
bundler. A loader of webpack and rspack gives the map only when the build makes source maps: with
`devtool: false` there is no map. esbuild needs no map: the plugin checks the file itself.

A map often has one segment per token, and a syntax finding can start inside a token: `(?<=` inside a regular
expression literal, or `??` in the segment of its left operand. When the source has the same text from the start of
the segment through the token of the finding, the finding keeps its offset in the segment. Otherwise the message
shows the start of the segment: the transform may have dropped text there, such as a comment or `as T`.

When there is no source map, or the map has no point for the finding, the message shows the position in the
checked code with the note `(position in the transpiled module)`. The line may then differ from the line in your
editor. The same happens when the map ends at code that a plugin loaded instead of the file. So in a Vite build a finding in a `.vue`
component points into the `.vue` file only when the build makes source maps (`build.sourcemap`):
`@vitejs/plugin-vue` gives the map of a component only then. The dev server of Vite always maps it to the
`.vue` file. In Rollup a plugin without a source map also gives the warning `Sourcemap is likely to be
incorrect` (`SOURCEMAP_BROKEN`) of Rollup, on each module with a finding: compatgate asks Rollup for the map.

## Partial findings

A partial finding of the level `warn` is part of a summary at the end of the build: one warning per feature, with
the number of places and the first five, in the order of the paths and the lines. A feature in one place keeps
its usual message. Two modules with other targets or another `compatgate.jsonc` give other texts of the core,
and so two summaries of one feature. Errors and the other warnings show one by one.

The summary needs a record of every checked module of the build, as the report of unused entries does
([allow-report.md](allow-report.md#when-a-build-has-no-report-of-unused-entries)). The record of a module keeps
its partial findings, so a watch rebuild summarizes the places of the modules from the cache too. Without a
record of every module the partial findings show one by one:

- **webpack and rspack.** Each module reports its partial findings, as it does its other warnings: webpack gives
  the warnings of a module from its memory cache again. At the end of a build with a record of every module, the
  plugin removes these warnings and adds the summaries. In production mode webpack does not emit a build with
  errors, and the summary comes with the emit: such a build shows the partial findings one by one. The first
  build of a process with the persistent cache has no records of the modules from the cache. The persistent
  cache of rspack does not give the warnings of a module again, of any loader: such a build shows the partial
  findings of the built modules only.
- **Rollup, Rolldown and the build of Vite.** The plugin keeps the partial findings until the end of the build.
  A build that fails shows the findings of its checked modules one by one.
- **The dev server of Vite.** It has no end of a build: a module warns of its partial findings at once.
- **esbuild.** It gives a plugin no list of the modules of a build, so the plugin cannot tell that it saw all of
  them: each partial finding is a warning of its own.

A child compilation of webpack or rspack, such as the one of html-webpack-plugin, keeps the partial findings of
its modules one by one: the end of the build sees only the warnings of the main compilation.

The summary is a warning of the build, not of a module: in webpack and rspack it has no module, and in Rollup,
Rolldown and Vite it has no `id`. In Rollup, Rolldown and the build of Vite the partial findings that show one
by one at the end of the build have no `id` either. A filter of warnings by the module does not match them,
such as `ignoreWarnings: [{ module: /node_modules/ }]` of webpack or an `onwarn` of Rollup or Vite that tests
`warning.id`. To leave modules out of the check, use the `include` and `exclude` options of the plugin. To drop
the partial findings from the output, match the message, such as `ignoreWarnings: [/compatgate\/partial/]`.

## Modules that do not parse

A module that the core cannot parse, such as Flow code in `node_modules`, gives one warning, and the build
goes on:

```text
[compatgate] cannot check node_modules/flow-lib/index.js: Flow is not supported
```
