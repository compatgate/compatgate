# Performance

This page describes how the rules read a file and what they cost.
The [README](../README.md) has the short version.

## How the rules read a file

The rules read only the text of the file: the core parses it with its own parser. The rules report in `create`
and return no visitor, so oxlint does not build the AST in JavaScript. The three rules share one check of a
file: the first rule checks it, and the other two take its findings.

## How the rules read the configs

The configuration of a file is the targets, the `allow` entries and the checker of its directory. The core
computes it once per directory with configs: a directory without configs takes the configuration of its parent.
On a later file the core checks the modification time and the size of the configs, at most once in 250 ms for the
whole process, so an edit shows in an IDE without a restart. A long base list in `extends` is read once, not per
file.

## Measurements

### A real service

The sources of a React application: 16 289 `.ts` and `.tsx` files, 16.8 MB, in a deep tree of directories. The
project has a `.browserslistrc`, a `compatgate.jsonc` with 3 entries and a base list of 45 entries in
`settings.compatgate.extends`. Apple M5, release build of the core, three rules on.

| Linter                                                         | Without the plugin | With the plugin          |
| -------------------------------------------------------------- | ------------------ | ------------------------ |
| oxlint 1.87, `oxlint src`, seven runs                          | 0.36 s             | 0.68 s (0.66–0.68 s)     |
| ESLint 10 with typescript-eslint, `Linter.verify`, 2 000 files | 265 µs per file    | 332 µs per file (+67 µs) |
| the same, all 16 289 files, three rounds                       | 308 µs per file    | 383 µs per file (+76 µs) |

oxlint gives 43 findings. In oxlint the plugin is most of the time: oxlint parses in Rust on all cores, and the
rules run in one JavaScript thread. In ESLint the plugin adds about a quarter to the time of ESLint with the
parser of typescript-eslint.

The cost of a file grows with its size: about 20 µs for a file of 1 KB on this service, about 80 µs for a file of
7 KB below.

### Many files in one directory

oxlint 1.87 on 2 000 JavaScript files (14.7 MB, Apple M5, 10 threads, release build of the core, median of
21 runs, three rules on). The numbers are approximate: they vary with the machine and the code.

| Configuration                                         | Time   |
| ----------------------------------------------------- | ------ |
| oxlint without the plugin and without rules           | 60 ms  |
| the plugin, targets and allow entries in the settings | 214 ms |
| the plugin, targets and `compatgate.jsonc` from files | 242 ms |
| the core alone, without the linter, on the same files | 90 ms  |

The plugin adds about 80 µs per file.
