// A platform without a native package of compatgate: the message tells what to install, not the advice of the loader
// of napi-rs to reinstall the dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const index = new URL('../src-js/index.ts', import.meta.url).href;
// The wasm job of CI has the wasm build: forcing it loads it.
const hasWasm =
  existsSync(new URL('../compatgate.wasm32-wasi.wasm', import.meta.url)) ||
  existsSync(new URL('../node_modules/@compatgate/core-wasm32-wasi', import.meta.url));

test('a binary that does not load names the platform and the wasm package', { skip: hasWasm }, () => {
  // `error` forces the WASI build without a fallback: a host with no wasm build fails as a platform without a binary.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(index)})`], {
    encoding: 'utf8',
    env: { ...process.env, NAPI_RS_FORCE_WASI: 'error' },
  });
  assert.notEqual(child.status, 0);
  assert.match(
    child.stderr,
    new RegExp(`@compatgate/core cannot load its binary on ${process.platform}-${process.arch}`),
  );
  assert.match(
    child.stderr,
    /install the WebAssembly build @compatgate\/core-wasm32-wasi: see Requirements in the README/,
  );
});
