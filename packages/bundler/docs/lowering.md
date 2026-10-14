# Syntax that the bundler lowers

This page describes how the plugin lowers syntax in Vite, Rolldown and esbuild.
The [README](../README.md) has the short version.

## Why the plugin lowers

Vite, Rolldown and esbuild lower the syntax for their target after the transforms of the plugins: the plugin
sees a class static block that the bundle will not have. When a module has a syntax finding, the plugin lowers
the module as the bundler will and checks the lowered code again. A build with the report of unused entries
lowers a module also when an `allow` entry suppressed syntax in it. A syntax finding that the lowered code does
not have goes; every other finding stays. When the lowered code keeps some findings of a feature and drops others,
the source map of the lowering tells them apart. The map gives the place of a finding of the lowered code when
the checked code has the same text from the start of its segment through the finding. When every finding of the
lowered code has such a place, and the places are distinct findings of the checked code, the other findings go.
Otherwise all of them stay: a finding that the lowering removed may stay, a finding that it kept never goes.
The lowering only removes findings: a helper that it adds gives none.

Rollup, webpack and rspack have no lowering of their own: the transpiler is a plugin or a loader before
compatgate, and the plugin sees its result.

## Target and engine

| Bundler  | Target                                                                           | Lowering                                           |
| -------- | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Vite 8+  | `build.rolldownOptions.transform.target`, else `build.target` of the environment | `transformWithOxc` of the `vite` of the project    |
| Rolldown | `transform.target`                                                               | `transformSync` of `rolldown/utils` of the project |
| esbuild  | `target` and `supported`                                                         | `transform` of the esbuild of the build            |

Vite 8 lowers each module through `transform.target` of Rolldown. The dev server lowers nothing, and the plugin
lowers as the build of the client would: a finding that the build lowers is no error in the dev server either.
The default target of Vite (`'baseline-widely-available'`) keeps a class static block, so it stays a finding
for older targets of browserslist. With `build.minify: 'esbuild'` Vite also lowers each chunk with esbuild;
the plugin does not repeat that.

No target, `false` and `esnext` lower nothing. The plugin takes the options that change the lowering:
`assumptions`, `typescript`, `decorator`, `helpers`, `plugins` and `jsx` of Rolldown with its `tsconfig`;
`jsx…` options and `tsconfigRaw`, `tsconfig` or the nearest `tsconfig.json` of esbuild. For esbuild the plugin
gives the text of that `tsconfig.json` as `tsconfigRaw` and does not follow its `extends`: a setting that only a
base config sets, such as `useDefineForClassFields`, does not reach the lowering. The plugin reads the
`tsconfig.json` of a directory once per build.

## A missing engine

The engine comes from the project: the plugin has no bundler among its dependencies. It resolves `vite` or
`rolldown/utils` from the root of the project, else from the process directory. When the engine is missing, the
syntax findings stay, and the build has one warning:

```text
[compatgate] cannot lower as Rolldown does: Cannot find module 'rolldown/utils'; syntax findings stay
```

The lowering in Vite needs Vite 8 or later. Vite 7 and older have no `transformWithOxc`: the syntax findings
stay, and the build has the same warning, `cannot lower as Vite does: Vite 8 or later is needed for the lowering
check`. A failed load of the engine stays for the life of the process: install the engine and restart a watch
build or the dev server.

When the lowering of a module fails, its findings stay too: the bundler reports its own error.

## Allow entries and the lowering

An `allow` entry counts as used when the lowered code still needs it: an entry for syntax that the bundler
lowers is not used. The plugin takes the indexes of the entries from the `suppressed` list of the check of the
module and keeps those that the check of the lowered code also gives. The helpers of the lowering use no entry
that the module did not use.
