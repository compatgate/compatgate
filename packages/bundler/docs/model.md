# How the plugin works

This page describes the plugin as a model: four tables of rules and a table of bundlers. It is for those who
change the plugin or add a bundler. The [README](../README.md) describes the plugin for its users.

The plugin is one pipeline for every bundler. The pipeline selects a module, finds its configuration, checks
it, checks the lowered code again where the bundler lowers the syntax, and reports at the end of the build.
Each property that differs between the bundlers comes from a host: one object per bundler. A new bundler is a
new host and a row of the host table, not a change of the pipeline.

## Table A. Module selection

One rule decides whether a module is checked and how it is parsed. The transform, the completeness test of the
reports (table D) and the filter of the bundler use it.

| Condition                                                     | Result                  |
| ------------------------------------------------------------- | ----------------------- |
| The id starts with `\0`, or the path is not absolute          | not checked             |
| `include` or `exclude` stops the path without the query       | not checked             |
| The environment of Vite is not a client one                   | not checked             |
| The extension of the path is a script one                     | parsed by the path      |
| The query has `type=style`                                    | not checked             |
| The query names a language (`lang.ts`, `lang=ts`) of a script | parsed in that language |
| The path is a component (`.vue`, `.svelte`, `.astro`)         | parsed as JavaScript    |
| Otherwise                                                     | not checked             |

The extensions are one table in `src/module-id.ts`. The filters of the transform and of esbuild come from it.
See [configs.md](configs.md#which-modules-are-checked).

## Table B. Configuration of a directory

The configuration of a module depends on the directory where the lookup of its configs starts, on the options
and on the project root, not on the file. The resolver of the core (`createResolver`) gives it:

| Field             | Content                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `targets`         | The browserslist query.                                                                     |
| `entries`         | The `allow` entries. Each has `origin` and `source`: the file and the index in its `allow`. |
| `checker`         | The checker of the core. Directories with the same configs share it.                        |
| `issues`          | Unknown feature ids and entries that every target supports, with their messages.            |
| `ignoredBrowsers` | browserslist names that compatgate has no data for.                                         |
| `watch`           | The configs to watch.                                                                       |
| `missing`         | The places in the project root where a new config may appear.                               |

The core watches one set of files per process: the `watch` and `missing` of every configuration and config error.
It checks them once per build. A change of any of them drops every configuration, and the modules compute theirs
again. The plugin keeps one configuration per checker, and one record per module (table D).

| Cache                        | Key                     | Reset                                                                                                                                   |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration of a directory | The lookup directory    | Kept until a change of a watched config. The core checks the configs once per build, the dev server of Vite after a change of any file. |
| Configurations               | The checker of the core | At the start of a build, if the last build did not use it; on an edit of a config in the dev server of Vite.                            |
| Records of the modules       | The id of the module    | A new check of the module; a walk over the graph drops the modules that left it.                                                        |

## Table C. Delivery of messages

Each message has a channel and a frequency. The frequencies are three: per module, per build and per process.
One function, `once(scope, key, emit)` of `PluginState`, decides whether a message shows.

| Message                                                           | webpack, rspack                                         | Rollup, Rolldown, the build of Vite, esbuild | The dev server of Vite    |
| ----------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| Finding of the level `error`                                      | error of the module                                     | one error at the end of the build            | error of the module       |
| Finding of the level `warn`                                       | warning of the module                                   | warning                                      | warning                   |
| Partial finding of the level `warn`                               | warning of the module, replaced by a summary at the end | a summary at the end; esbuild: warning       | warning                   |
| Module that does not parse                                        | warning of the module                                   | warning                                      | warning                   |
| Config error, unknown feature id of an own entry                  | error, once per build                                   | error, once per build                        | error of each module      |
| Unknown id of a base, entry of every target, browser without data | warning of the build, once per process                  | warning, once per process                    | warning, once per process |
| Missing lowering engine                                           | none                                                    | warning, once per build                      | warning, once per build   |
| Unused entries                                                    | warning at the end, if complete                         | the same; esbuild: none                      | none                      |

The frequency "each module in the dev server" needs no rule of its own: the dev server has one build for its
life, so its config errors take the module scope.

## Table D. Completeness of the reports

The summary of partial findings and the report of unused entries need a record of every checked module of the
graph of the build. The plugin keeps a record per module: its configuration, the entries that it used and its
partial findings. A record lives as long as the plugin instance, not one build: a module that a watch build takes
from a cache keeps the record of the build that checked it. A new check of a module replaces its record. The
bundler checks a module again on a change of its code or of its configs, which the module watches.

The key of a record is the id of the module in webpack and rspack (`module.identifier()`: the resource with the
loaders and the layer), and the module id elsewhere. A report is complete when each module of the graph that
table A selects has a record of its current code. A module from the persistent cache in a new process has none.
A module that webpack or rspack built in this build without the transform failed in another loader: its record
is of older code, and the plugin drops it. A failed build drops the records that it set: Rollup keeps the cache
of the build before it. The walk covers the whole graph and drops the records of the modules that left it, so
the records take no more memory than the graph. A module of a child compilation of webpack keeps its record
apart: its entries count as used, its configuration gives no entries to report, and the walk neither needs nor
drops it.

| Host                                | List of the modules of the graph                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| webpack, rspack                     | `compilation.modules`, with the inner modules of a concatenated module, through the filter of the loader rule; `compilation.builtModules` tells the built modules |
| Rollup, Rolldown, the build of Vite | `this.getModuleIds()` without the external modules; none for a failed build                                                                                       |
| esbuild, the dev server of Vite     | none: no reports                                                                                                                                                  |

The walk costs tens of milliseconds in a large build. It runs when a module of this build holds a partial
finding, when the records give an unused entry, or when a record is older than this build: it may belong to a
module that left the graph.

Without a complete report the partial findings show one by one, and the unused entries are not reported. See
[hosts.md](hosts.md#partial-findings) and [allow-report.md](allow-report.md).

## Hosts

One row per bundler. Each column is one property of the host interface in `src/hosts/host.ts`.

| Host     | Project root          | Positions                             | Lowering                            | Errors                                    | New config file        | List of modules                             | Partial findings                      |
| -------- | --------------------- | ------------------------------------- | ----------------------------------- | ----------------------------------------- | ---------------------- | ------------------------------------------- | ------------------------------------- |
| webpack  | `compiler.context`    | `inputSourceMap` of the loaders       | none                                | error of the module                       | `addMissingDependency` | `compilation.modules`                       | `record`; a child compilation: `show` |
| rspack   | `compiler.context`    | `inputSourceMap` of the loaders       | none                                | error of the module                       | `addMissingDependency` | `compilation.modules`                       | `record`; a child compilation: `show` |
| Vite     | `config.root`         | `this.getCombinedSourcemap()`         | `transformWithOxc`                  | at the end; the dev server: of the module | none                   | `this.getModuleIds()`; the dev server: none | `hold`; the dev server: `show`        |
| Rollup   | the process directory | `this.getCombinedSourcemap()`         | none                                | at the end                                | `this.addWatchFile`    | `this.getModuleIds()`                       | `hold`                                |
| Rolldown | the `cwd` option      | `this.getCombinedSourcemap()`         | `transformSync` of `rolldown/utils` | at the end                                | none                   | `this.getModuleIds()`                       | `hold`                                |
| esbuild  | `absWorkingDir`       | the source: the plugin loads the file | `transform` of esbuild              | at the end                                | `addWatchFile`         | none                                        | `show`                                |

The modes of partial findings:

- `record`: the module warns, and the plugin keeps the finding. At the end a complete report takes the warnings
  back and adds the summaries. A cache gives the warnings of a module again, so they stay with the module.
- `hold`: the plugin keeps the finding, and the end of the build shows it, in a summary or one by one. A warning
  of the context of Rollup cannot be taken back.
- `show`: the module warns, and there is no summary.

Rsbuild runs the host of rspack with the process directory as the root. Another bundler of unplugin, such as
Farm or Bun, gets the host of Rollup without a new config file.

## Code

| File                          | Responsibility                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | The unplugin instance and the plugin of each bundler.                                             |
| `src/<bundler>.ts`            | The subpath of one bundler, such as `@compatgate/bundler/vite`: its plugin as the default export. |
| `src/plugin.ts`               | The hooks of unplugin: the pipeline with the host of the bundler.                                 |
| `src/pipeline.ts`             | The transform of a module, the reports at the end of a build, the error of a build.               |
| `src/check.ts`                | The check of one module, the check of its lowered code, the messages of findings.                 |
| `src/summary.ts`              | The places of findings and the summary of partial findings.                                       |
| `src/state.ts`                | The state of a plugin instance: configurations, `once`, unused entries.                           |
| `src/records.ts`              | Table D: the records of the modules, and the walk over the graph.                                 |
| `src/options.ts`              | The options and the `include` and `exclude` filter.                                               |
| `src/checkers.ts`             | One configuration per checker of the core.                                                        |
| `src/source-map.ts`           | The way from the checked code to the source.                                                      |
| `src/lowering.ts`             | The lowering of Vite, Rolldown and esbuild.                                                       |
| `src/module-id.ts`            | Table A: the file of a module id, and the extensions.                                             |
| `src/hosts/host.ts`           | The host interface.                                                                               |
| `src/hosts/index.ts`          | The host table.                                                                                   |
| `src/hosts/loader.ts`         | The host of a loader: webpack and rspack.                                                         |
| `src/hosts/plugin-context.ts` | The host of the context of Rollup: Rollup, Rolldown, Vite.                                        |
| `src/hosts/<bundler>.ts`      | The properties of one bundler.                                                                    |
