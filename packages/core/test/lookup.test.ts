import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FAKE_ROOT, fakePath, toSlashes } from '@compatgate/test-utils';
import { configLookupDirectory } from '../src-js/lookup.ts';

test('the lookup of a file inside node_modules starts above the outermost node_modules', () => {
  assert.equal(configLookupDirectory(fakePath('p', 'node_modules', 'lib', 'src', 'a.js')), FAKE_ROOT);
  assert.equal(
    configLookupDirectory(fakePath('p', 'node_modules', '.pnpm', 'lib@1.0.0', 'node_modules', 'lib', 'a.js')),
    FAKE_ROOT,
  );
  assert.equal(configLookupDirectory(fakePath('p', 'node_modules', 'a', 'node_modules', 'b', 'b.js')), FAKE_ROOT);
  assert.equal(configLookupDirectory(fakePath('node_modules', 'lib', 'a.js')), fakePath());
});

test('the lookup of any other file starts in its directory', () => {
  assert.equal(configLookupDirectory(fakePath('p', 'src', 'a.js')), fakePath('p', 'src'));
  assert.equal(configLookupDirectory(fakePath('p', 'my_node_modules', 'a.js')), fakePath('p', 'my_node_modules'));
  assert.equal(configLookupDirectory(fakePath('p', 'node_modules_old', 'a.js')), fakePath('p', 'node_modules_old'));
});

test('the node_modules segments that hold the root do not count', () => {
  const root = fakePath('t', 'nm', 'node_modules', 'proj');
  assert.equal(
    configLookupDirectory(fakePath('t', 'nm', 'node_modules', 'proj', 'src', 'a.js'), root),
    fakePath('t', 'nm', 'node_modules', 'proj', 'src'),
  );
  assert.equal(
    configLookupDirectory(fakePath('t', 'nm', 'node_modules', 'proj', 'node_modules', 'lib', 'a.js'), root),
    fakePath('t', 'nm', 'node_modules', 'proj'),
  );
  assert.equal(
    configLookupDirectory(fakePath('t', 'nm', 'node_modules', 'proj', 'src', 'a.js'), fakePath('t')),
    fakePath('t', 'nm'),
  );
  // A file outside the root, such as a package that a monorepo hoists above the project.
  assert.equal(
    configLookupDirectory(fakePath('repo', 'node_modules', 'lib', 'a.js'), fakePath('repo', 'packages', 'app')),
    fakePath('repo'),
  );
  assert.equal(
    configLookupDirectory(fakePath('repo', 'packages', 'app', 'src', 'a.js'), fakePath('repo', 'packages', 'app')),
    fakePath('repo', 'packages', 'app', 'src'),
  );
  // A dependency of that project, hoisted next to it, is outside the root: its own configs do not apply.
  assert.equal(configLookupDirectory(fakePath('t', 'nm', 'node_modules', 'other', 'a.js'), root), fakePath('t', 'nm'));
});

test('a directory whose name starts with two dots is inside the root', () => {
  assert.equal(
    configLookupDirectory(
      fakePath('t', 'node_modules', 'p', '..x', 'node_modules', 'lib', 'a.js'),
      fakePath('t', 'node_modules', 'p'),
    ),
    fakePath('t', 'node_modules', 'p', '..x'),
  );
});

// Vite and Rollup pass `D:/p/src/a.js` on Windows.
test(
  'on Windows a path with forward slashes takes the lookup of its directory',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    assert.equal(configLookupDirectory(toSlashes(fakePath('p', 'node_modules', 'lib', 'a.js'))), FAKE_ROOT);
    assert.equal(configLookupDirectory(toSlashes(fakePath('p', 'src', 'a.js'))), fakePath('p', 'src'));
  },
);
