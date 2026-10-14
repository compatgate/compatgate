import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// The subpaths resolve through "exports" to the built dist and its types, as for a consumer.
import * as bundler from '@compatgate/bundler';
import esbuild from '@compatgate/bundler/esbuild';
import rolldown from '@compatgate/bundler/rolldown';
import rollup from '@compatgate/bundler/rollup';
import rspack from '@compatgate/bundler/rspack';
import vite from '@compatgate/bundler/vite';
import webpack from '@compatgate/bundler/webpack';

test('a CommonJS config such as webpack.config.js loads the package with require', () => {
  // The package refers to itself through its "exports", so the test loads the built dist.
  const bundler = createRequire(import.meta.url)('@compatgate/bundler') as Record<string, unknown>;
  for (const name of ['compatgateWebpack', 'compatgateRspack', 'compatgateVite', 'compatgateRollup']) {
    assert.equal(typeof bundler[name], 'function', name);
  }
});

test('each bundler has a subpath whose default export is its plugin', () => {
  assert.equal(vite, bundler.compatgateVite);
  assert.equal(webpack, bundler.compatgateWebpack);
  assert.equal(rspack, bundler.compatgateRspack);
  assert.equal(rollup, bundler.compatgateRollup);
  assert.equal(rolldown, bundler.compatgateRolldown);
  assert.equal(esbuild, bundler.compatgateEsbuild);
  // The type of a default export is the plugin of its bundler.
  const plugin: ReturnType<typeof bundler.compatgateVite> = vite({ targets: 'Chrome >= 97' });
  assert.equal(typeof plugin, 'object');
});
