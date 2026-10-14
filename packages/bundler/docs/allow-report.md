# The report of allow entries

This page describes how the plugin reports the `allow` entries of a project, and when a build has no report.
The [README](../README.md) has the short version.

## What the plugin reports

The plugin reports the entries of your project that it does not need: the `allow` of `compatgate.jsonc` and the
`allow` option. The entries of `extends`, of the config and of the option, are left out: a list shared by many
projects is wider than any of them. The messages name the config and the index of the entry in its `allow`, or
the option: `compatgate.allow[2]`. The linter names the entries in the same form.

An unknown feature id of the project is an error of the build. An entry for a feature that every target
supports is a warning, one per entry:

```text
[compatgate] compatgate.jsonc, allow[1]: unknown feature "api.Fetch". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone". Did you mean "api.fetch"?
[compatgate] compatgate.jsonc, allow[2]: every target browser supports "api.fetch". Remove the entry.
```

An unknown feature id of a base is a warning that names the base config: such a list may name a feature that a
newer compatgate knows.

```text
[compatgate] node_modules/@acme/compat/compatgate.jsonc, allow[4]: unknown feature "api.Foo". compatgate ignores the entry.
```

The plugin learns the configs of a build from its modules, so these messages come with the first module of
each config. A browserslist name that compatgate has no data for, such as `ie` of `ie 11`, is a warning too:
compatgate does not check that browser. The browsers that BCD lacks by definition, such as `op_mini` of
`defaults`, give no warning: the README of `@compatgate/core` lists them.

## How often the messages show

The warnings about a config show once per process: a rebuild in watch mode and a second build of the same config
do not repeat them. In webpack and rspack they are warnings of the build, not of a module, so the persistent
cache does not give them again. The error of an unknown id shows in each build, on the first module of the
config. In webpack watch mode it may show twice in one build: a module from the cache keeps its error, and the
first rebuilt module of the config reports it again. Config errors behave the same. The dev server of Vite
reports the error on each module of the config.

## Unused entries

At the end of a build one warning per config lists the entries that suppressed no finding in any module:

```text
[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "api.Highlight". Remove them unless other code needs them
```

The entries of the `allow` option are one warning that names each entry as `compatgate.allow[i]`:

```text
[compatgate] allow entries that suppressed no finding in the code of this build: compatgate.allow[0] "api.Highlight". Remove them unless other code needs them
```

An entry counts as used when it suppressed a finding in a module of the build, with any targets of its config.
An entry of a config that another config takes through `extends` counts as used when it suppressed a finding in a
module of either.
The core gives the entries that suppressed a finding in the `suppressed` list of each check. In Vite, Rolldown and
esbuild an entry for syntax that the bundler lowers is not used: see [lowering.md](lowering.md).

## When a build has no report of unused entries

The report needs a record of every checked module of the build. The plugin keeps a record per module: its
configuration and the entries that it used. A record lives as long as the plugin, not one build. So a rebuild in
watch mode reports: a module that the bundler takes from its cache keeps the record of the build that checked
it. This holds for webpack watch mode, the memory cache of rspack and its rebuild of the changed modules only, and
the cache of Rollup watch mode.

The bundler checks a module again when its code or one of its configs changes, and the new check replaces the
record. Two modules of one file, such as with other loaders by a rule of the issuer, have a record each. An
edit of `compatgate.jsonc` checks the modules of that config again; the modules of other configs keep their
records. A module that leaves the build, deleted or no longer imported, leaves the report, and the plugin
drops its record. An external module does not count.

A build has no report without a word when the entries that a checked module needs are unknown:

- The first build of a process with the persistent cache of webpack or rspack. The modules from the cache were
  checked by another process.
- A module that another loader or plugin fails on: the transform of compatgate never sees its code. In webpack
  and rspack this holds in watch mode too: a module that the bundler built again without the transform has a
  record of its old code only.
- A rebuild after a failed build in Rollup, Rolldown and the build of Vite. Rollup keeps the cache of the build
  before the failed one, so the plugin drops the records of a failed build: an error of compatgate, or of
  another plugin at the end of the build.
- A module whose configs have an error, such as an invalid query in `.browserslistrc`: compatgate does not check
  it. In watch mode the fix of the config checks the module again, and the report comes back.
- A config that the build read in two versions where an index names another feature: an edit of the config between
  two modules of one build, such as with two compilers in one process. An edit of only `files` or `packages` keeps
  the report: an entry is reported when it suppressed no finding in either version. The other configs of the build are reported.
- A build that fails before its end. webpack in production mode does not emit a build with errors
  (`optimization.emitOnErrors: false`), and the plugin gives the report on the emit: a build with any error has no
  report there.

The entries of a config whose modules are all in a child compilation of webpack or rspack, such as the one of
html-webpack-plugin, are never reported. An entry that a module of a child compilation needs counts as used.

esbuild gives a plugin no list of the modules of a build, and the dev server of Vite has no end of a build:
neither has the report. A config can serve other builds too, such as the linter of the tests, so check an entry
before you remove it.

The summary of partial findings needs every checked module too: without it the partial findings show one by
one. See [hosts.md](hosts.md#partial-findings).
