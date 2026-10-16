# Contributing

## Setup

- Node.js 24 and pnpm 12.9.1: `corepack enable` picks the version of `packageManager`.
- Rust: rustup installs the toolchain of `rust-toolchain.toml`.
- cargo-about 0.9.2, only for `pnpm third-party`, which writes the licenses of the crates of the binary:
  `cargo install cargo-about@0.9.2 --features cli --locked`. CI pins the same version.

```sh
pnpm install
pnpm run check
```

`pnpm run check` runs everything that CI runs: the check of the generated data, the format, the linters, the tests
of Rust and JavaScript and the type check.

## Compatibility data

`crates/compatgate/src/data/generated.rs` comes from `@mdn/browser-compat-data`. After an update of the package,
run `pnpm generate` and commit the result.

## Changes

- A change of a published package records a change intent: run `pnpm change`, pick the packages and the bump, and
  commit the file in `.changeset/` with the change. The release workflow turns the intents into versions and
  changelogs.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).
