import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { displayPath, isInside } from '../src-js/paths.ts';

const root = join('/', 'p');

test('isInside holds for the directory itself and the paths below it', () => {
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, join(root, 'src', 'a.ts')), true);
  // A name that starts with two dots is a file of the directory, not its parent.
  assert.equal(isInside(root, join(root, '..a.ts')), true);
  assert.equal(isInside(root, join('/', 'q', 'a.ts')), false);
  assert.equal(isInside(root, join('/', 'pq', 'a.ts')), false);
  assert.equal(isInside(join(root, 'src'), root), false);
});

test('displayPath names a path below the root relative to it', () => {
  assert.equal(displayPath(join(root, 'src', 'a.ts'), root), join('src', 'a.ts'));
  assert.equal(displayPath(join(root, '..a.ts'), root), '..a.ts');
  // The root itself would be an empty name.
  assert.equal(displayPath(root, root), root);
  assert.equal(displayPath(join('/', 'q', 'a.ts'), root), join('/', 'q', 'a.ts'));
  assert.equal(displayPath(join(root, 'a.ts'), undefined), join(root, 'a.ts'));
});
