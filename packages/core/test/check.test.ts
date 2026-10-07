import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bcdVersion, check, clearAllowCache } from '../src/index.ts';

test('check resolves targets and compatgate.jsonc from the filename', () => {
  clearAllowCache();
  const root = mkdtempSync(join(tmpdir(), 'compatgate-check-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.browserslistrc'), 'Chrome >= 97\n');
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "allow": [{ "feature": "api.structuredClone", "files": ["src/allowed/**"] }] }');
  const source = 'structuredClone(1);';
  assert.equal(check(source, { filename: join(root, 'src/a.js') }).findings.length, 1);
  assert.equal(check(source, { filename: join(root, 'src/allowed/a.js') }).findings.length, 0);
});

test('explicit targets and allow skip file lookup', () => {
  const result = check('new Intl.Segmenter();', { filename: '/nowhere/a.js', targets: 'Firefox >= 115', allow: [] });
  assert.deepEqual(result.findings.map(finding => finding.feature), ['javascript.builtins.Intl.Segmenter']);
});

test('bcdVersion is exported', () => {
  assert.equal(bcdVersion(), '8.1.4');
});
