# AGENTS.md

Guidance for AI agents and people who change compatgate. `CONTRIBUTING.md` has the setup of the tools; this file has
the rules that the code does not show.

## What it is

compatgate finds JavaScript syntax and APIs that the browsers of a browserslist query do not support. The checker is
Rust (oxc parses the code, `@mdn/browser-compat-data` gives the support). Node.js reaches it through a napi binding,
and two adapters use it: rules for ESLint and oxlint, and a plugin for webpack, rspack, Vite, Rollup, Rolldown and
esbuild.

| Path                  | What                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `crates/compatgate`   | The checker: detection (`src/detect`), support data (`src/data`), allow entries, positions |
| `packages/core`       | `@compatgate/core`: the napi binding (`src`, Rust) and the JS layer (`src-js`)             |
| `packages/eslint`     | `@compatgate/eslint`: the rules for ESLint and oxlint                                      |
| `packages/bundler`    | `@compatgate/bundler`: the unplugin plugin, one host per bundler (`src/hosts`)             |
| `packages/test-utils` | Private: temporary projects and fake paths for the tests                                   |
| `conformance`         | Private: one fixture checked by every linter and bundler, with the expected findings       |
| `scripts`             | Data generation, licenses, tarball checks, the smoke check, release helpers                |
| `.github/workflows`   | `ci.yml`, `build.yml` (binaries of 9 targets, reused), `release.yml`                       |

The core reads configs (`compatgate.jsonc`, browserslist) and caches them; the adapters only map their options and
report. `packages/bundler/docs/model.md` describes the plugin as tables of rules.

## Commands

```sh
pnpm run check            # generated data, format, lint, tests, types; CI also builds the binaries
pnpm run build:debug      # the debug binary of the core and the JS of every package
pnpm --filter @compatgate/core test
node --test --test-name-pattern='<name>' packages/bundler/test/plugin.test.ts   # one test
cargo test -p compatgate <name>                                                # one Rust test
BLESS=1 cargo test --test corpus   # writes the current findings into crates/compatgate/tests/corpus
pnpm generate             # after an update of @mdn/browser-compat-data
pnpm change               # a change intent; `pnpm change`, `pnpm version` and `pnpm lane` are pnpm 12 commands
actionlint && zizmor .github       # after a change of the workflows
```

Node 24 runs the TypeScript tests as they are: no build step for tests. The JS tests of a package need the debug
binary of the core: run `pnpm run build:debug` after a change of Rust.

## Where to start

- A new check: `crates/compatgate/src/detect` — `syntax.rs` (syntax by AST node), `regex.rs` (regular
  expressions), `globals.rs` (globals, constructors, members of singletons such as `navigator.x`), `methods.rs`
  (prototype methods by name, such as `.toSorted()`); a snippet with its expected findings in the corpus; and
  `packages/core/docs/checks.md`.
- A new option or setting: the schema in `packages/core/src-js/options.ts` or in the adapter
  (`packages/eslint/src/settings.ts`, `packages/bundler/src/options.ts`), a test in the `test` directory of the
  package, and the README of the package.
- A new bundler: a host in `packages/bundler/src/hosts` with its row in `hosts/index.ts`, an entry in `src` and in
  `exports`, `docs/hosts.md` and `docs/model.md`, and `conformance/test/bundlers.test.ts`.
- An update of the support data: `@mdn/browser-compat-data` and `@types/web` are pinned to exact versions in the
  root `package.json`; update them with `pnpm add -D -w <name>@<version>`, run `pnpm generate`, then `BLESS=1`
  for the corpus and a review of the changed expectations.

## Code

- Repository text is English: code, comments, docs, commit messages.
- A comment says why, not what the next lines do. It gives the reason itself: no other project as the example
  ("as X does"). A comparison with other projects belongs in the commit message.
- Docs and comments use plain English: one idea per sentence, present tense, one term for one thing.
- TypeScript is ESM with `erasableSyntaxOnly`: no enums, no parameter properties, imports with the `.ts` extension.
- Paths: compare with `samePath` and test containment with `isInside` (`packages/core/src-js/paths.ts`), never with
  string equality. A message names a path through `displayPath`/`displayPaths`: relative to the root with `/` on
  every system, absolute outside the root. API data (`watch`, `missing`) keeps native absolute paths.
- Options, settings, `compatgate.jsonc` and allow entries are checked by `checkOptions` with a schema
  (`SHARED_SCHEMA` and its extensions): own keys only, `__proto__` rejected at any depth. A new option is a schema
  entry, not a hand-written check.
- Errors of configs are subclasses of `ConfigError` (`TargetsConfigError`, `AllowConfigError`) and carry `watch` and
  `missing`: a fix of any of those files must start a new check.
- The report of unused allow entries may miss an entry, but never lists an entry that a check used. When the plugin
  cannot tell which entries the modules of a build need, the build has no report: see
  `packages/bundler/docs/allow-report.md`.
- Input comes from dependencies too: any size of config, query or id must end in a result or a clear error. Code
  that walks input of any depth uses a loop or a limit, not unbounded recursion: a native stack overflow ends the
  process. `packages/core/test/limits.test.ts` runs each case in a process of its own for that reason.
- Rust: clippy warnings fail CI; no `print!`, `dbg!` or `todo!`. `count!` adds to the step counters of the tests.

## Tests

- Write the test first and watch it fail.
- The tests of a package live in its `test` directory; the tests of the checker in `crates/compatgate/tests` and in
  the modules of `crates/compatgate/src`.
- Temporary projects: `createProject` of `@compatgate/test-utils` (real paths, removed after the test file);
  `fakePath`/`FAKE_ROOT` for a path that must not exist.
- A test of Windows behavior is skipped elsewhere: `{ skip: process.platform !== 'win32' }`. CI runs the tests on
  Windows x64 and arm64, macOS, Linux glibc and musl, and wasm.
- A test that spawns a process passes a long script through stdin: a command line of Windows has a limit of 32 767
  characters.
- The corpus (`crates/compatgate/tests/corpus`) holds snippets with their expected findings in comments; its
  `README.md` describes the format.

## Generated files

Do not edit these files by hand: change their source and run the command. CI checks that `generated.rs` is current.

| File                                                | Made by                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `crates/compatgate/src/data/generated.rs`           | `pnpm generate` from `@mdn/browser-compat-data` |
| `packages/core/binding.js`, `binding.d.ts`          | `pnpm run build:debug`; they hold the version   |
| `packages/*/CHANGELOG.md`, `.changeset/ledger.yaml` | `pnpm version -r` in `release.yml`              |
| `packages/core/THIRD-PARTY-LICENSE`                 | `pnpm third-party`; not committed               |

The formatter leaves the files of pnpm (`.changeset`, `CHANGELOG.md`) alone: pnpm writes them in its own form.

## Changes and releases

- A change of a published package records an intent: `pnpm change` asks for the packages and the bump (`patch`,
  `minor`, `major` or `none`) and writes a file into `.changeset/`. Commit it with the change. The release takes
  the version from the intents: never set a version by hand. CI runs `pnpm change check`.
- Commit messages follow Conventional Commits.
- The three packages share one version (`versioning.fixed` in `pnpm-workspace.yaml`). `maxBump: minor` keeps a major
  intent out of `main`: a breaking change waits in a branch of its own.
- Only `release.yml` publishes, through npm trusted publishing (OIDC) in the environment `npm`. Never publish from a
  machine, and never run `pnpm publish --dry-run` in this repository: `prepublishOnly` of the core runs
  `napi pre-publish`, which publishes for real.
- The release flow: a push to `main` runs `pnpm version -r`; pending intents update the draft PR
  "chore: version packages". The owner marks it ready, which starts CI, and merges it. The merge brings a version
  that npm lacks: `release.yml` builds the binaries, publishes the platform packages, waits until npm serves them,
  publishes the main packages, creates one GitHub Release `v<version>` and installs the packages from npm.
- Prereleases: `pnpm lane next --filter @compatgate/core --filter @compatgate/eslint --filter @compatgate/bundler`
  gives `X.Y.Z-next.N` under the npm tag `next`; `pnpm lane main` returns to stable versions. `pnpm lane` rewrites
  the `versioning` block without its comments: restore its form by hand.
- napi writes the package version into the committed `packages/core/binding.js`; the version job of `release.yml`
  rebuilds it, and the build of every target checks that it matches.

## CI

- Pull requests run the cheap jobs; the binaries of 9 targets and their tests run when Rust, the binding, the
  workflows, the smoke check or the napi packages in `pnpm-lock.yaml` change. To build another branch, run the
  workflow Build by hand (Actions, Build, Run workflow). A push to `main` runs the cheap jobs only: `main` takes
  up-to-date pull requests, whose head CI built.
- The ruleset of `main` requires one check, `CI result`: it fails when any job of `ci.yml` fails, is cancelled or
  skips where it should not. A new job goes into its `needs`, not into the ruleset.
- Actions are pinned by commit SHA with the version in a comment. Every checkout sets `persist-credentials: false`;
  `taiki-e/install-action` installs pinned tools with `fallback: none`. A value of `${{ }}` reaches a `run` script
  through `env`, never inline. zizmor and actionlint check the workflows.
- Every job has `timeout-minutes`.

## Before you finish

- `pnpm run check` passes.
- A change of a published package has an intent from `pnpm change`.
- A change of the public API is in the README of the package; `packages/core/test/readme.test.ts` checks the core.
- A change of the workflows passes `actionlint` and `zizmor .github`.
