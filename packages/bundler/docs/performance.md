# Performance

This page describes what the plugin does with each module and what it costs in a real build.
The [README](../README.md) has the short version.

## What the plugin does with a module

The plugin runs in the `transform` hook after the other plugins and loaders. For each JavaScript or TypeScript
module it:

1. takes the configuration of the directory of the module: the targets, the `allow` entries and the checker.
   The core computes it once per directory with configs and checks the configs once per build; a directory without
   configs takes the configuration of its parent. A build of 16 731 modules computes a few configurations, not 16 731.
2. checks the code with the core, a native module in Rust;
3. formats the findings: it maps the position to the source through the source map of the earlier loaders or
   plugins, and names the place of the `allow` entries;
4. in Vite, Rolldown and esbuild, lowers a module with a syntax finding as the bundler does and checks it again.
   See [lowering.md](lowering.md).

The plugin returns no code: the module goes on as it is.

## Measurements on a real service

The service is a React application with 16 731 modules in the browser bundle (20.8 MB, 6 632 modules from
`node_modules`). The project has a `.browserslistrc` with `Chrome >= 97, iOS >= 15.5, Safari >= 15.6,
Firefox >= 115`, a `compatgate.jsonc` with 3 entries and a base list of 45 entries in the `extends` option. One
entry of the base, `api.URL.canParse`, has an unknown id, so 44 entries apply. Every severity is `warn`. The
machine is an Apple M5, the core is a release build. The numbers vary with the machine and the code: read them as
an order of magnitude.

### rspack

A production build of the browser bundle only, without the type checker. Five series of seven rounds; each round
builds every variant once, in turn. The increment of a round is the time of the variant minus the time of the
build without the plugin in the same round. The table gives the median of the five series medians and the range
of the series medians.

| Variant                                              | Time or increment | Range of the series |
| ---------------------------------------------------- | ----------------- | ------------------- |
| without the plugin                                   | 4.20 s            | 3.94–4.82 s (round) |
| a `transform` that returns at once (unplugin loader) | +0.21 s           | +0.12…+0.22 s       |
| the configuration of the module, without the check   | +0.27 s           | +0.19…+0.44 s       |
| the plugin                                           | +0.43 s (+10 %)   | +0.39…+0.53 s       |

The increment of a single round lies between −0.23 s and +0.75 s: compare builds of one series only. Split by
stage, as paired differences of the same rounds:

| Stage                                            | Increment | Range of the series |
| ------------------------------------------------ | --------- | ------------------- |
| the loader of unplugin, with no work in it       | +0.21 s   | +0.12…+0.22 s       |
| the configuration of the module                  | +0.09 s   | −0.04…+0.17 s       |
| the check in the core and the output of findings | +0.17 s   | +0.09…+0.22 s       |

The stages do not add up to the plugin: +0.47 s against +0.43 s. Each row is the median of its own differences,
and a median of a sum is not the sum of the medians. A round varies by more than a stage costs, so each median
picks other rounds.

The JavaScript thread of the plugin spends 628–713 ms on the 16 731 modules: 198–220 ms on the configuration
and 291–345 ms in the core (sums over the modules, four builds). rspack runs its own work on other threads at
the same time, so the build gets longer by less than that.

The build gives 506 findings: 20 messages one by one and 3 summaries of partial features. Mapping their positions
through the source maps of the loaders costs about 20 ms.

### Vite

A build of Vite 8.3 with an entry that imports 17 libraries of the same service: 3 101 modules, 7.0 MB. Nine
rounds after two warm-up rounds, each with every variant in turn. The slice has a fifth of the modules of the
service, mostly the code of libraries, so its numbers do not compare with the rspack build.

| Variant                            | Median  | Range of the rounds |
| ---------------------------------- | ------- | ------------------- |
| without the plugin                 | 185 ms  | 179–186 ms          |
| a `transform` that returns at once | +30 ms  | +21…+44 ms          |
| the plugin                         | +178 ms | +175…+195 ms        |

The build gives 3 findings one by one and 1 summary of a partial feature in 301 places. The plugin lowers only the
modules with a syntax finding, as `build.target` of Vite does.

### What changes the cost

- **The number of modules.** The cost grows with the modules, about 26 µs per module in this rspack build.
- **Directories with configs.** Each one adds one computation of its configuration, kept until a config changes;
  a directory without configs adds a lookup of its parent only. A project with one config in the root computes one
  configuration per process, and a build only checks that its configs are unchanged.
- **The length of the `allow` lists.** A list is read once per build: a long base list costs little more than a
  short one.
- **Findings.** Each finding needs its position from a source map. Hundreds of findings add tens of milliseconds.
- **Watch builds and the dev server.** The plugin checks only the modules that the bundler transforms again.
