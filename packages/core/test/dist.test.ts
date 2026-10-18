import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Imports the package by its name, so Node resolves "exports" to the built dist, as consumers do.
import * as published from '@compatgate/core';

test('the published entry point exports the public API', () => {
  const names = [
    'AllowConfigError',
    'ConfigError',
    'OptionsError',
    'SHARED_SCHEMA',
    'TargetsConfigError',
    'bcdVersion',
    'checkOptions',
    'clearCaches',
    'createResolver',
    'isCheckable',
  ];
  // The lookup, the reads of the configs and the messages are internal: a configuration gives what they gave.
  assert.deepEqual(Object.keys(published).sort(), [...names].sort());
  const { checker } = published.createResolver({ targets: 'Chrome >= 97', allow: [] }).resolve('a.js');
  const [finding] = checker.check('structuredClone(1);', 'a.js').findings;
  assert.equal(finding?.feature, 'api.structuredClone');
  assert.equal(
    finding?.message,
    'api.structuredClone is not supported in Chrome 97 (since 98). ' +
      'Check the feature in code, or add "api.structuredClone" to options.allow.',
  );
  const resolver = published.createResolver({ targets: 'Chrome >= 97', allow: [] });
  assert.deepEqual(resolver.check('structuredClone(1);', 'a.js').findings, [finding]);
  assert.equal(published.isCheckable('a.vue'), false);
});

test('the package exports its package.json', () => {
  const path = createRequire(import.meta.url).resolve('@compatgate/core/package.json');
  assert.equal(createRequire(import.meta.url)(path).name, '@compatgate/core');
});

test('the package exports the schema of compatgate.jsonc', () => {
  const path = createRequire(import.meta.url).resolve('@compatgate/core/compatgate.schema.json');
  assert.equal(createRequire(import.meta.url)(path).title, 'compatgate.jsonc');
});
