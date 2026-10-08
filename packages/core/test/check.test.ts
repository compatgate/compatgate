import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bcdVersion, check, clearAllowCache, validateAllow } from '../src-js/index.ts';

test('check resolves targets and compatgate.jsonc from the filename', () => {
  clearAllowCache();
  const root = mkdtempSync(join(tmpdir(), 'compatgate-check-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.browserslistrc'), 'Chrome >= 97\n');
  writeFileSync(
    join(root, 'compatgate.jsonc'),
    '{ "allow": [{ "feature": "api.structuredClone", "files": ["src/allowed/**"] }] }',
  );
  const source = 'structuredClone(1);';
  assert.equal(check(source, { filename: join(root, 'src/a.js') }).findings.length, 1);
  assert.equal(check(source, { filename: join(root, 'src/allowed/a.js') }).findings.length, 0);
});

test('explicit targets and allow skip file lookup', () => {
  const result = check('new Intl.Segmenter();', { filename: '/nowhere/a.js', targets: 'Firefox >= 115', allow: [] });
  assert.deepEqual(
    result.findings.map(finding => finding.feature),
    ['javascript.builtins.Intl.Segmenter'],
  );
});

test('check takes inline allow entries', () => {
  const source = 'structuredClone(1); Object.groupBy(a, f);';
  const result = check(source, {
    filename: '/p/src/a.js',
    targets: 'Chrome >= 60',
    allow: ['javascript.builtins.Object.groupBy', { feature: 'api.structuredClone', files: ['src/**'] }],
    baseDir: '/p',
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.usedAllow, [0, 1]);
});

test('check returns a syntax error in the result', () => {
  const result = check('const = ;', { filename: '/p/a.js', targets: 'Chrome >= 97', allow: [] });
  assert.equal(result.parseError?.line, 1);
});

test('validateAllow takes inline entries', () => {
  assert.deepEqual(validateAllow(['api.DoesNotExist', { feature: 'javascript.builtins.Array.at' }], 'Chrome >= 97'), [
    { index: 0, kind: 'unknown-feature' },
    { index: 1, kind: 'native-in-targets' },
  ]);
});

test('bcdVersion is exported', () => {
  assert.equal(bcdVersion(), '8.1.4');
});
