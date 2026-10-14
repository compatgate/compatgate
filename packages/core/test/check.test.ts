import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChecker } from '../src-js/checker.ts';
import { AllowConfigError, bcdVersion, clearCaches } from '../src-js/index.ts';
import { check, resolveConfiguration } from './resolve.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'compatgate-check-'));
  roots.push(root);
  return root;
}

test('check resolves targets and compatgate.jsonc from the filename', () => {
  clearCaches();
  const root = tempRoot();
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
  assert.deepEqual(result.suppressed, [
    { index: 0, kind: 'builtin' },
    { index: 1, kind: 'api' },
  ]);
});

test('check returns a syntax error in the result', () => {
  const result = check('const = ;', { filename: '/p/a.js', targets: 'Chrome >= 97', allow: [] });
  assert.equal(result.parseError?.line, 1);
});

test('a checker of inline entries reports their issues', () => {
  const checker = createChecker({
    targets: 'Chrome >= 97',
    allow: ['api.DoesNotExist', { feature: 'javascript.builtins.Array.at' }],
  });
  assert.deepEqual(checker.issues(), [
    { index: 0, kind: 'unknown-feature' },
    { index: 1, kind: 'native-in-targets' },
  ]);
});

test('bcdVersion is exported', () => {
  assert.equal(bcdVersion(), '8.1.4');
});

test('check puts the entries of extends before the entries of the project', () => {
  clearCaches();
  const root = tempRoot();
  // The base package is installed next to the builder, not above the checked file.
  const base = join(root, 'builder/node_modules/@builder/allow');
  mkdirSync(base, { recursive: true });
  mkdirSync(join(root, 'service'));
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: '@builder/allow' }));
  writeFileSync(join(base, 'compatgate.jsonc'), '{ "allow": ["api.structuredClone"] }');
  writeFileSync(join(root, 'service/compatgate.jsonc'), '{ "allow": ["javascript.builtins.Object.groupBy"] }');
  const source = 'Object.groupBy(a, f); structuredClone(1);';
  const options = { filename: join(root, 'service/a.js'), targets: 'Chrome >= 97', baseDir: join(root, 'builder') };
  assert.deepEqual(
    check(source, options).findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
  assert.throws(
    () => check(source, { ...options, extends: ['@builder/allow'], baseDir: join(root, 'service') }),
    /cannot resolve/,
  );
  const result = check(source, { ...options, extends: ['@builder/allow'] });
  assert.deepEqual(result.findings, []);
  // Index 0 is the entry of the base, index 1 is the entry of compatgate.jsonc.
  assert.deepEqual(result.suppressed, [
    { index: 0, kind: 'api' },
    { index: 1, kind: 'builtin' },
  ]);
});

test('the indexes of suppressed point into the entries of resolveConfiguration', () => {
  clearCaches();
  const root = tempRoot();
  writeFileSync(join(root, 'base.jsonc'), '{ "allow": ["api.structuredClone"] }');
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": "./base.jsonc", "allow": ["api.fetch"] }');
  const options = { filename: join(root, 'a.js'), targets: 'Chrome >= 97' };
  const { entries } = resolveConfiguration(options.filename, options);
  assert.deepEqual(
    entries.map(entry => [entry.feature, entry.origin]),
    [
      ['api.structuredClone', 'inherited'],
      ['api.fetch', 'own'],
    ],
  );
  assert.deepEqual(check('structuredClone(1);', options).suppressed, [{ index: 0, kind: 'api' }]);
});

test('createChecker and check do not take the origin of an entry: compatgate sets it', () => {
  const entry = { feature: 'api.structuredClone', origin: 'inherited' } as never;
  assert.throws(() => createChecker({ targets: 'Chrome >= 97', allow: [entry] }), AllowConfigError);
  assert.throws(() => check('', { filename: '/p/a.js', targets: 'Chrome >= 97', allow: [entry] }), AllowConfigError);
});
