import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';

import { FAKE_ROOT, fakePath, toSlashes } from '@compatgate/test-utils';
import { displayPath, displayPaths, isInside, samePath } from '../src-js/paths.ts';

const root = FAKE_ROOT;

test('isInside holds for the directory itself and the paths below it', () => {
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, join(root, 'src', 'a.ts')), true);
  // A name that starts with two dots is a file of the directory, not its parent.
  assert.equal(isInside(root, join(root, '..a.ts')), true);
  assert.equal(isInside(root, fakePath('q', 'a.ts')), false);
  assert.equal(isInside(root, fakePath('pq', 'a.ts')), false);
  assert.equal(isInside(join(root, 'src'), root), false);
});

// A relative name has `/` separators on every system, as in the messages of esbuild, Vite and TypeScript: a message
// reads the same everywhere, and the name of a config goes into it as it is.
test('displayPaths names a path below the root relative to it, with / separators', () => {
  assert.equal(displayPaths(join(root, 'src', 'a.ts'), root), 'src/a.ts');
  assert.equal(displayPaths(join(root, '..a.ts'), root), '..a.ts');
  // The root itself would be an empty name.
  assert.equal(displayPaths(root, root), root);
  assert.equal(displayPaths(fakePath('q', 'a.ts'), root), fakePath('q', 'a.ts'));
  assert.equal(displayPaths(fakePath('pq', 'a.ts'), root), fakePath('pq', 'a.ts'));
  assert.equal(displayPaths(fakePath('q', 'p', 'a.ts'), root), fakePath('q', 'p', 'a.ts'));
  assert.equal(displayPaths(join(root, 'a.ts'), undefined), join(root, 'a.ts'));
});

test('displayPaths names every path of a message', () => {
  const a = join(root, 'a.jsonc');
  const b = join(root, 'configs', 'b.jsonc');
  const outside = fakePath('q', 'c.jsonc');
  assert.equal(
    displayPaths(`${a}: circular "extends": ${a} -> ${b} -> ${outside}`, root),
    `a.jsonc: circular "extends": a.jsonc -> configs/b.jsonc -> ${outside}`,
  );
  assert.equal(
    displayPaths(`Browserslist config found in "${b}" and "${a}"`, root),
    'Browserslist config found in "configs/b.jsonc" and "a.jsonc"',
  );
});

// A relative name has `/` separators on every system, as in the messages of esbuild and Vite.
test('displayPath names a path below the root relative to it, with / separators', () => {
  assert.equal(displayPath(join(root, 'src', 'a.ts'), root), 'src/a.ts');
  // A name that starts with two dots is a file of the root, not of its parent.
  assert.equal(displayPath(join(root, '..a.ts'), root), '..a.ts');
  // The root itself would be an empty name.
  assert.equal(displayPath(root, root), root);
  assert.equal(displayPath(fakePath('q', 'a.ts'), root), fakePath('q', 'a.ts'));
  assert.equal(displayPath(fakePath('pq', 'a.ts'), root), fakePath('pq', 'a.ts'));
});

// Vite and Rollup give `D:/p/src/a.ts` on Windows, and the case of the drive may differ from the one of `baseDir`.
test(
  'on Windows displayPaths names a path with either separator and either case of the drive',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const slashes = toSlashes(fakePath('p', 'src', 'a.ts'));
    const lower = fakePath('p', 'src', 'a.ts').replace(/^[A-Z]:/, drive => drive.toLowerCase());
    assert.equal(displayPaths(`in ${slashes} and ${lower}`, root), 'in src/a.ts and src/a.ts');
  },
);

// A backslash is a character of a name on macOS and Linux, not a separator.
test('on macOS and Linux a backslash in a name stays', { skip: process.platform === 'win32' }, () => {
  assert.equal(displayPaths(join(root, 'a\\b.ts'), root), 'a\\b.ts');
  assert.equal(displayPath(join(root, 'a\\b.ts'), root), 'a\\b.ts');
});

test('samePath holds for two spellings of one path', () => {
  assert.equal(samePath(root, root), true);
  assert.equal(samePath(root, `${root}${sep}`), true);
  assert.equal(samePath(root, join(root, 'src', '..')), true);
  assert.equal(samePath(root, join(root, 'src')), false);
});

test(
  'on Windows samePath takes either separator and either case of the drive',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    assert.equal(samePath(root, toSlashes(root)), true);
    assert.equal(
      samePath(
        root,
        root.replace(/^[A-Z]:/, drive => drive.toLowerCase()),
      ),
      true,
    );
  },
);
