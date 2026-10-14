import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { displayPaths, isInside } from '../src-js/paths.ts';

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

test('displayPaths names a path below the root relative to it', () => {
  assert.equal(displayPaths(join(root, 'src', 'a.ts'), root), join('src', 'a.ts'));
  assert.equal(displayPaths(join(root, '..a.ts'), root), '..a.ts');
  // The root itself would be an empty name.
  assert.equal(displayPaths(root, root), root);
  assert.equal(displayPaths(join('/', 'q', 'a.ts'), root), join('/', 'q', 'a.ts'));
  assert.equal(displayPaths(join('/', 'pq', 'a.ts'), root), join('/', 'pq', 'a.ts'));
  assert.equal(displayPaths(join('/', 'q', 'p', 'a.ts'), root), join('/', 'q', 'p', 'a.ts'));
  assert.equal(displayPaths(join(root, 'a.ts'), undefined), join(root, 'a.ts'));
});

test('displayPaths names every path of a message', () => {
  const a = join(root, 'a.jsonc');
  const b = join(root, 'configs', 'b.jsonc');
  const outside = join('/', 'q', 'c.jsonc');
  assert.equal(
    displayPaths(`${a}: circular "extends": ${a} -> ${b} -> ${outside}`, root),
    `a.jsonc: circular "extends": a.jsonc -> ${join('configs', 'b.jsonc')} -> ${outside}`,
  );
  assert.equal(
    displayPaths(`Browserslist config found in "${b}" and "${a}"`, root),
    `Browserslist config found in "${join('configs', 'b.jsonc')}" and "a.jsonc"`,
  );
});
