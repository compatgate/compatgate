import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkFiles } from './pack-check.js';

const base = ['package.json', 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'dist/index.js', 'dist/index.d.ts'];

test('a tarball with the expected files passes', () => {
  assert.deepEqual(
    checkFiles('core', [...base, 'binding.js', 'binding.d.ts', 'THIRD-PARTY-LICENSE', 'docs/syntax-ranges.md']),
    [],
  );
  assert.deepEqual(checkFiles('eslint', [...base, 'docs/configs.md']), []);
});

test('a missing required file is an error', () => {
  assert.deepEqual(
    checkFiles(
      'core',
      base.filter(file => file !== 'LICENSE-MIT'),
    ),
    [
      'core: missing LICENSE-MIT',
      'core: missing binding.js',
      'core: missing binding.d.ts',
      'core: missing THIRD-PARTY-LICENSE',
    ],
  );
});

test('a file outside the allowed patterns is an error', () => {
  const extra = ['compatgate.darwin-arm64.node', 'src-js/index.ts', 'test/a.test.ts', 'dist/tsconfig.tsbuildinfo'];
  assert.deepEqual(
    checkFiles('eslint', [...base, ...extra]).sort(),
    extra.map(file => `eslint: unexpected ${file}`).sort(),
  );
});

test('the files of the core are not allowed in another package', () => {
  assert.deepEqual(
    checkFiles('bundler', [...base, 'binding.js']).filter(error => error.includes('binding')),
    ['bundler: unexpected binding.js'],
  );
});
