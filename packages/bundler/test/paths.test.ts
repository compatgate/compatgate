import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { displayPath } from '../src/paths.ts';

const root = join('/', 'p');

test('displayPath names a path below the root relative to it', () => {
  assert.equal(displayPath(join(root, 'src', 'a.ts'), root), join('src', 'a.ts'));
  // A name that starts with two dots is a file of the root, not of its parent.
  assert.equal(displayPath(join(root, '..a.ts'), root), '..a.ts');
  // The root itself would be an empty name.
  assert.equal(displayPath(root, root), root);
  assert.equal(displayPath(join('/', 'q', 'a.ts'), root), join('/', 'q', 'a.ts'));
  assert.equal(displayPath(join('/', 'pq', 'a.ts'), root), join('/', 'pq', 'a.ts'));
});
