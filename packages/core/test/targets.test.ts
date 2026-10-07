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
