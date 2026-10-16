// The reader of the corpus follows `tests/corpus.rs`: these cases repeat its tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { differences, placedAllow, positionOfByte, readCorpusFile, splitLines } from '../src/corpus.ts';

test('an expectation is a line comment that starts with the marker', () => {
  const source =
    "x; //~ none\nf(' //~ a'); //~ none\n//~ none\nf('//~');\n// Each `//~` holds it.\n/* //~ none */ y;\n`\n//~ none\n`;\n";
  const file = readCorpusFile('a.js', source);
  assert.deepEqual(
    [...file.expectations].map(([line, { code }]) => [line, code.length]),
    [
      [1, 3],
      [2, 13],
      [3, 0],
    ],
  );
});

test('lines split as check counts them', () => {
  assert.deepEqual(splitLines('a; //~ none\r\nb;\rc;\u2028d;\u2029e;\n'), ['a; //~ none', 'b;', 'c;', 'd;', 'e;', '']);
});

test('a finding on a line without a marker is a difference, and so is a missing one', () => {
  const file = readCorpusFile('a.js', 'x;\nstructuredClone(1);\nstructuredClone(2); //~ api.structuredClone exact\n');
  const finding = { feature: 'api.structuredClone', confidence: 'exact' } as const;
  assert.deepEqual(differences(file, [{ line: 2, column: 1, ...finding }]), [
    'a.js:2\n    structuredClone(1);\n  - (no `//~`)\n  + api.structuredClone exact',
    'a.js:3\n    structuredClone(2);\n  - api.structuredClone exact\n  + none',
  ]);
});

test('a line with two findings of one feature compares their columns', () => {
  const file = readCorpusFile('a.js', 'f(a.share, b.share); //~ @3 x exact; @12 x exact\n');
  const at = (column: number) => ({ line: 1, column, feature: 'x', confidence: 'exact' }) as const;
  assert.deepEqual(differences(file, [at(12), at(3)]), []);
  assert.equal(differences(file, [at(12), at(4)]).length, 1);
});

test('an expectation that is not `[@column] feature confidence` fails', () => {
  assert.throws(() => readCorpusFile('a.js', 'x; //~ api.x sure\n'), /a\.js:1: `api\.x sure`/);
  assert.throws(() => readCorpusFile('a.js', 'x; //~\n'), /an empty expectation/);
  assert.throws(() => readCorpusFile('a.js', 'x;\n'), /no `\/\/~` expectations/);
});

test('the header sets the targets, the filename and the allow entries', () => {
  const file = readCorpusFile(
    'a.js',
    '// targets: Chrome >= 50\n// filename: /p/node_modules/x/a.js\n// allow: ["a.b", {"feature": "c", "files": ["*.js"]}, {"feature": "d", "baseDir": "/p"}]\nx; //~ none\n',
  );
  assert.equal(file.targets, 'Chrome >= 50');
  assert.equal(file.filename, '/p/node_modules/x/a.js');
  // A copy of the corpus moves the filename and every `baseDir` into its root.
  assert.deepEqual(placedAllow('/tmp/r', file), [
    'a.b',
    { feature: 'c', files: ['*.js'], baseDir: join('/tmp/r', 'p/node_modules/x') },
    { feature: 'd', baseDir: join('/tmp/r', 'p') },
  ]);
});

test('a module and a script parse as the core parses them', () => {
  assert.equal(readCorpusFile('a.js', 'import x from "x"; //~ none\n').sourceType, 'module');
  assert.equal(readCorpusFile('a.js', 'return; //~ none\n').sourceType, 'commonjs');
  assert.equal(readCorpusFile('a.mjs', 'x; //~ none\n').sourceType, 'module');
  assert.throws(() => readCorpusFile('a.mjs', 'return; //~ none\n'), /not a valid program/);
});

test('a byte offset of oxlint is a column in UTF-16 code units', () => {
  // `ж` is two bytes and one code unit; `😀` is four bytes and two code units.
  const source = "a;\nconst s = 'ж😀'; f();\n";
  assert.deepEqual(positionOfByte(source, Buffer.byteLength("a;\nconst s = 'ж😀'; ")), { line: 2, column: 18 });
});
