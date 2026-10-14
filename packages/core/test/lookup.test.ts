import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configLookupDirectory } from '../src-js/lookup.ts';

test('the lookup of a file inside node_modules starts above the outermost node_modules', () => {
  assert.equal(configLookupDirectory('/p/node_modules/lib/src/a.js'), '/p');
  assert.equal(configLookupDirectory('/p/node_modules/.pnpm/lib@1.0.0/node_modules/lib/a.js'), '/p');
  assert.equal(configLookupDirectory('/p/node_modules/a/node_modules/b/b.js'), '/p');
  assert.equal(configLookupDirectory('/node_modules/lib/a.js'), '/');
});

test('the lookup of any other file starts in its directory', () => {
  assert.equal(configLookupDirectory('/p/src/a.js'), '/p/src');
  assert.equal(configLookupDirectory('/p/my_node_modules/a.js'), '/p/my_node_modules');
  assert.equal(configLookupDirectory('/p/node_modules_old/a.js'), '/p/node_modules_old');
});

test('the node_modules segments that hold the root do not count', () => {
  const root = '/t/nm/node_modules/proj';
  assert.equal(configLookupDirectory('/t/nm/node_modules/proj/src/a.js', root), '/t/nm/node_modules/proj/src');
  assert.equal(configLookupDirectory('/t/nm/node_modules/proj/node_modules/lib/a.js', root), '/t/nm/node_modules/proj');
  assert.equal(configLookupDirectory('/t/nm/node_modules/proj/src/a.js', '/t'), '/t/nm');
  // A file outside the root, such as a package that a monorepo hoists above the project.
  assert.equal(configLookupDirectory('/repo/node_modules/lib/a.js', '/repo/packages/app'), '/repo');
  assert.equal(configLookupDirectory('/repo/packages/app/src/a.js', '/repo/packages/app'), '/repo/packages/app/src');
  // A dependency of that project, hoisted next to it, is outside the root: its own configs do not apply.
  assert.equal(configLookupDirectory('/t/nm/node_modules/other/a.js', root), '/t/nm');
});

test('a directory whose name starts with two dots is inside the root', () => {
  assert.equal(
    configLookupDirectory('/t/node_modules/p/..x/node_modules/lib/a.js', '/t/node_modules/p'),
    '/t/node_modules/p/..x',
  );
});
