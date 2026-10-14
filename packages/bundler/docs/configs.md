# Modules and configs

This page describes which modules the plugin checks, which configs apply to them and how the plugin sees
their edits. The [README](../README.md) has the short version.

## Which modules are checked

The plugin checks JavaScript and TypeScript modules: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts` and
`.tsx`, in your code and in `node_modules`. The query and the hash of a module id (`/src/a.ts?v=123`) do not
count. Besides:

- A module with a language in the query, such as `App.vue?vue&type=script&lang.ts` (Vite) or
  `App.vue?vue&type=script&lang=ts` (vue-loader), is parsed in that language.
- A `.vue`, `.svelte` or `.astro` component without a language is parsed as JavaScript: the plugin of the
  framework has compiled it before the check.
- Styles, JSON, assets and virtual modules (an id that starts with `\0` or is no absolute path) are not checked.

`allow` entries match the path of the module: an entry with `files: "src/*.vue"` covers the script of
`src/App.vue`.

## Which configs apply

Each module takes the browserslist config and the `compatgate.jsonc` above its file, unless the options give
`targets` or `allow`. The entries of the `extends` option come first; the project can only add entries to them.

A module in `node_modules` takes the configs of the project: the lookup starts above the outermost
`node_modules`. The configs that a dependency ships do not apply, and the plugin does not watch them. An entry
with `packages: ["lib"]` in the project config covers the modules of `lib`. A `node_modules` directory that holds
the project root does not count: a project that lies inside `node_modules` keeps its own configs.

The plugin sees the path that the bundler resolves. A linked workspace package (`pnpm link`, `workspace:`)
resolves through its symlink to its own directory, outside `node_modules`, and takes its own configs. With
`resolve.symlinks: false` in webpack, rspack and Rolldown, `resolve.preserveSymlinks` in Vite or `preserveSymlinks`
in Rollup and esbuild, its path stays in `node_modules`, and it takes the configs of the project.

## Edits of the configs

The plugin makes the bundler watch the configs of each module: `compatgate.jsonc` and the files of its
`extends`, the files of the `extends` option and the browserslist config. An edit of any of them checks the
modules again in the next build of watch mode or of the dev server, and the persistent cache of webpack and rspack
checks them again too. A change of one watched config makes the core read every config again: it drops all its
caches. A broken config is watched as well, so its fix shows in the next build.

A new `compatgate.jsonc` or browserslist config in the project root shows in the next build of webpack, rspack,
Rollup and esbuild: a `.browserslistrc`, a `browserslist`, a new package.json, or a `browserslist` field added to
the package.json of the root. The project root is the root of the bundler: see the table of hosts in
[model.md](model.md). A new config in another directory, such as `src/`, and a `browserslist` field added to a
package.json there show after a restart: the plugin watches only the project root for a new config. With the
persistent cache of webpack and rspack, delete the cache as well: a module from the cache keeps its findings.
Each module registers the places it watches: the places of every directory made an rspack build of 16 731
modules about 0.06 s slower. In
Rolldown and in a watch build of Vite a new config in the root also shows after a restart: the watcher of
Rolldown does not see a new file. The dev server of Vite does not watch a missing file either: it takes a
watched file of a transform for an import of the module, so a missing file would break the module. There a new
config shows at the next edit of the module. An edit inside a shared config of browserslist `extends` shows
after a restart in every bundler: Node.js keeps the loaded package.

## Errors in the configs

An error in a config (`compatgate.jsonc`, a browserslist config, an `allow` entry) is an error of the build
with the text of the core. A build reports it once, on the first module that uses the config. The dev server
of Vite reports it on each module of the config.
