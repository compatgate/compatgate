import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveTargets } from '../src/targets.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'compatgate-targets-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

test('reads .browserslistrc above the file', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 100\nFirefox >= 120\n', 'src/a.js': '' });
  assert.equal(resolveTargets(join(root, 'src/a.js')), 'Chrome >= 100, Firefox >= 120');
});

test('reads the browserslist field of package.json', () => {
  const root = project({ 'package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }), 'a.js': '' });
  assert.equal(resolveTargets(join(root, 'a.js')), 'Safari >= 16');
});

test('falls back to defaultTargets and then to defaults', () => {
  const root = project({ 'a.js': '' });
  assert.equal(resolveTargets(join(root, 'a.js'), { defaultTargets: 'Chrome >= 97' }), 'Chrome >= 97');
  assert.equal(resolveTargets(join(root, 'a.js')), 'defaults');
});

test('expands extends relative to the file, not to the process directory', () => {
  const root = project({
    'node_modules/browserslist-config-base/package.json': JSON.stringify({ name: 'browserslist-config-base' }),
    'node_modules/browserslist-config-base/index.js': "module.exports = ['Safari >= 16'];",
    'node_modules/browserslist-config-foo/package.json': JSON.stringify({ name: 'browserslist-config-foo' }),
    'node_modules/browserslist-config-foo/index.js': "module.exports = ['Chrome >= 100', 'extends browserslist-config-base'];",
    '.browserslistrc': 'extends browserslist-config-foo\nFirefox >= 120\n',
    'src/a.js': '',
  });
  assert.equal(resolveTargets(join(root, 'src/a.js')), 'Chrome >= 100, Safari >= 16, Firefox >= 120');
});

test('picks the environment section of a shared config', () => {
  const root = project({
    'node_modules/browserslist-config-env/package.json': JSON.stringify({ name: 'browserslist-config-env' }),
    'node_modules/browserslist-config-env/index.js': "module.exports = { defaults: ['Chrome >= 90'], legacy: ['Chrome >= 50'] };",
    '.browserslistrc': 'extends browserslist-config-env\n',
    'a.js': '',
  });
  assert.equal(resolveTargets(join(root, 'a.js')), 'Chrome >= 90');
});

test('an extends package that cannot be resolved is an error that names it', () => {
  const root = project({ '.browserslistrc': 'extends browserslist-config-missing\n', 'a.js': '' });
  assert.throws(() => resolveTargets(join(root, 'a.js')), /browserslist-config-missing/);
});
