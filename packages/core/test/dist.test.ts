import { test } from 'node:test';
import assert from 'node:assert/strict';

// Imports the package by its name, so Node resolves "exports" to the built dist, as consumers do.
import * as published from '@compatgate/core';

test('the published entry point exports the public API', () => {
  const names = [
    'ALLOW_FILE',
    'AllowConfigError',
    'TargetsConfigError',
    'bcdVersion',
    'check',
    'clearAllowCache',
    'findAllowFile',
    'loadAllow',
    'loadAllowFile',
    'resolveTargets',
    'validateAllow',
  ];
  for (const name of names) {
    assert.ok(name in published, name);
  }
  const result = published.check('structuredClone(1);', { filename: 'a.js', targets: 'Chrome >= 97', allow: [] });
  assert.equal(result.findings[0]?.feature, 'api.structuredClone');
});
