# Configs of the rules

This page describes which configs apply to a file, how the rules see their edits and how they report errors.
The [README](../README.md) has the short version.

## Which configs apply

The rules look for the browserslist config and `compatgate.jsonc` from the file up to the root. The settings
`targets` and `allow` replace the lookup of their config. The entries of the `extends` setting come first, then
the entries of the project.

A file inside `node_modules` takes the configs of the project: the lookup starts above the outermost
`node_modules`, and the configs that a dependency ships do not apply. The cwd of the linter is the project root:
a `node_modules` directory that holds it does not count, so a project that lies inside `node_modules` keeps its
own configs.

A relative file name resolves against the cwd of the linter. Text without a file name, such as `<input>`, takes
the configs of the cwd and is parsed as JavaScript.

## Code blocks of processors

A code block of a processor, such as `README.md/0.js`, takes the configs of the physical file `README.md`
and the parser of its own name. The `files` patterns of `allow` match the physical file too: `**/*.md`
covers the code blocks of all Markdown files.

## Files that the rules skip

A file that the core does not parse is skipped. A source with a syntax error gives no messages: the parser of
the linter reports the error itself.

Vue and Svelte single-file components are checked only by `@compatgate/bundler`. A parser such as
`vue-eslint-parser` gives the rules the whole `.vue` or `.svelte` text, and the rules skip it.

## Edits and caches

The core watches the configs that the rules have read: `compatgate.jsonc`, the files of `extends` and the
browserslist config that applies. It also watches the places of a new `compatgate.jsonc` or browserslist config in
the project root, the directory of the linter, and the package.json of the root, which may get the `browserslist`
field. A change of any of these files drops every cached config, and the next file reads the configs again. The
change shows in an IDE without a restart, within 250 ms: the core checks the watched files at most once in this
time.

Two changes need a restart of the linter. A new `compatgate.jsonc` or browserslist config in another directory,
such as `src/`, a `browserslist` field added to a package.json there included: the core watches only the project
root for a new config. An edit inside a shared config of browserslist `extends`, as Node.js keeps the loaded
package.

`eslint --cache` does not see these configs: it lints a file again only when the file or the ESLint config
changes. Delete the cache file (`.eslintcache` by default) after an edit of `compatgate.jsonc` or of the
browserslist config.

## Errors

An error of a config is a message of the `exact` rule at line 1, column 1 of each file that the config covers.
Such errors are a broken `compatgate.jsonc` or file of its `extends`, an invalid allow entry or glob, an unknown
feature id in the allow entries of the project, an invalid query and a broken browserslist config. The settings
`targets` and `allow` count as configs too. ESLint and oxlint report the message the same way: an IDE shows it
in the file, the other rules and files are checked, and the lint fails. The `heuristic` and `partial` rules do
not repeat the message. The message belongs to the `exact` rule: with `exact` off, a broken config shows
nothing. The message names the place of the entry, as in the bundler:

```text
compatgate.jsonc, allow[1]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".
```

An unknown feature id hides no finding, so the rules check the file too. With any other error of a config the
rules check nothing else in the file.

An unknown key or a value of a wrong type in `settings.compatgate` fails the rule, as ESLint fails a rule with
wrong options. It is an `OptionsError` of `@compatgate/core`. ESLint stops with the error and the name of the
rule; oxlint reports the error for each file.

An unknown feature id in a base list of `extends` is a warning of the process (`COMPATGATE_ALLOW`), once per
entry: a list shared by many projects may name a feature that a newer compatgate knows.

An allow entry for a feature that all targets now support is no error in the linter: a warning about a
config would repeat in every file. `@compatgate/bundler` reports such entries once per build.
