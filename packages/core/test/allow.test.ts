import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AllowConfigError, clearAllowCache, loadAllow, loadAllowFile } from '../src/allow.ts';

beforeEach(() => clearAllowCache());

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'compatgate-allow-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

test('finds compatgate.jsonc above the file and reads comments and both entry forms', () => {
  const root = project({
    'compatgate.jsonc': `{
      // Closed by a core-js polyfill
      "allow": [
        "api.structuredClone",
        { "feature": "api.ResizeObserver", "packages": ["some-lib"], "files": ["src/desktop/**"] },
      ],
    }`,
    'src/a.ts': '',
  });
  const config = loadAllow(join(root, 'src/a.ts'));
  assert.equal(config.path, join(root, 'compatgate.jsonc'));
  assert.deepEqual(config.entries, [
    { feature: 'api.structuredClone', packages: [], files: [], baseDir: root },
    { feature: 'api.ResizeObserver', packages: ['some-lib'], files: ['src/desktop/**'], baseDir: root },
  ]);
});

test('returns no entries without a config', () => {
  const root = project({ 'a.ts': '' });
  assert.deepEqual(loadAllow(join(root, 'a.ts')), { path: null, entries: [] });
});

test('extends a relative file and a package, inherited entries first', () => {
  const root = project({
    'node_modules/@company/compat-allow/package.json': JSON.stringify({ name: '@company/compat-allow' }),
    'node_modules/@company/compat-allow/compatgate.jsonc': '{ "allow": ["api.A"] }',
    'shared/base.jsonc': '{ "allow": ["api.B"] }',
    'compatgate.jsonc': '{ "extends": ["@company/compat-allow", "./shared/base.jsonc"], "allow": ["api.C"] }',
  });
  const features = loadAllowFile(join(root, 'compatgate.jsonc')).entries.map(entry => entry.feature);
  assert.deepEqual(features, ['api.A', 'api.B', 'api.C']);
});

test('the same file reached twice through extends is not a cycle', () => {
  const root = project({
    'base.jsonc': '{ "allow": ["api.A"] }',
    'b.jsonc': '{ "extends": "./base.jsonc" }',
    'c.jsonc': '{ "extends": "./base.jsonc" }',
    'compatgate.jsonc': '{ "extends": ["./b.jsonc", "./c.jsonc"] }',
  });
  assert.equal(loadAllowFile(join(root, 'compatgate.jsonc')).entries.length, 2);
});

test('a circular extends is an error', () => {
  const root = project({ 'a.jsonc': '{ "extends": "./b.jsonc" }', 'b.jsonc': '{ "extends": "./a.jsonc" }' });
  assert.throws(() => loadAllowFile(join(root, 'a.jsonc')), AllowConfigError);
});

test('invalid content is an error that names the file', () => {
  const root = project({
    'syntax.jsonc': '{ "allow": [ }',
    'shape.jsonc': '{ "allow": [{ "feature": 1 }] }',
    'key.jsonc': '{ "allow": [{ "feature": "api.A", "reason": "x" }] }',
  });
  for (const name of ['syntax.jsonc', 'shape.jsonc', 'key.jsonc']) {
    assert.throws(() => loadAllowFile(join(root, name)), (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.match(error.message, new RegExp(name.replace('.', '\\.')));
      return true;
    });
  }
});

test('a missing relative extends names the config that references it', () => {
  const root = project({ 'compatgate.jsonc': '{ "extends": "./missing.jsonc" }' });
  const config = join(root, 'compatgate.jsonc');
  assert.throws(() => loadAllowFile(config), (error: unknown) => {
    assert.ok(error instanceof AllowConfigError);
    assert.ok(error.message.includes(config), error.message);
    assert.ok(error.message.includes('missing.jsonc'), error.message);
    return true;
  });
});

test('extends may name a jsonc file inside a package', () => {
  const root = project({
    'node_modules/@co/allow/package.json': JSON.stringify({ name: '@co/allow' }),
    'node_modules/@co/allow/strict.jsonc': '{ "allow": ["api.S"] }',
    'compatgate.jsonc': '{ "extends": "@co/allow/strict.jsonc" }',
  });
  assert.deepEqual(loadAllowFile(join(root, 'compatgate.jsonc')).entries.map(entry => entry.feature), ['api.S']);
});

test('an unresolvable package names the file it looked for', () => {
  const root = project({ 'compatgate.jsonc': '{ "extends": "@co/nothing" }' });
  assert.throws(() => loadAllowFile(join(root, 'compatgate.jsonc')), /@co\/nothing\/compatgate\.jsonc/);
});
