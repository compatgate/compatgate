# compatgate

compatgate finds JavaScript syntax and APIs that your browserslist targets do not support, in the linter and in the
bundler, with one config and one set of findings.

| Package                                          | What it is                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| [`@compatgate/eslint`](packages/eslint#readme)   | Rules for ESLint and oxlint.                                                |
| [`@compatgate/bundler`](packages/bundler#readme) | A plugin for webpack, rspack, Vite, Rollup, Rolldown and esbuild.           |
| [`@compatgate/core`](packages/core#readme)       | The checker that both use: a native module in Rust with a JavaScript layer. |

## Requirements

- Node.js 22.12 or later. The packages are ESM, and a CommonJS config loads them with `require`.
- `@compatgate/eslint`: ESLint 9 or 10, or oxlint 1.
- `@compatgate/bundler`: webpack 5, rspack 2, Vite 8, Rollup 4, Rolldown 1 or esbuild 0.28. The tests run on these
  versions.

## Quick start

The linter shows a finding in the editor:

```sh
npm install --save-dev @compatgate/eslint
```

```jsonc
// .oxlintrc.json
{
  "jsPlugins": [{ "name": "compatgate", "specifier": "@compatgate/eslint" }],
  "rules": { "compatgate/exact": "error", "compatgate/heuristic": "warn", "compatgate/partial": "warn" },
}
```

The bundler checks the code that goes into the bundle, after the transpiler:

```sh
npm install --save-dev @compatgate/bundler
```

```js
// rspack.config.js
const { compatgateRspack } = require('@compatgate/bundler');

module.exports = {
  plugins: [compatgateRspack()],
};
```

Both read the browserslist config of the project and `compatgate.jsonc` for the features that you allow. The
README of each package describes its setup for ESLint, Vite and the other bundlers.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

Compatibility data: [@mdn/browser-compat-data](https://github.com/mdn/browser-compat-data) (CC0-1.0).
