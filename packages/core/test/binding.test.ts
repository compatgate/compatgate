import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as binding from '../binding.js';
const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

test('check returns findings with readable versions', () => {
  const result = binding.check('structuredClone(1);', { filename: 'a.js', targets: TARGETS });
  assert.deepEqual(result.findings, [
    {
      feature: 'api.structuredClone',
      kind: 'api',
      confidence: 'exact',
      start: { line: 1, column: 0 },
      end: { line: 1, column: 15 },
      unsupported: [{ browser: 'chrome', target: '97', since: '98' }],
    },
  ]);
  assert.deepEqual(result.usedAllow, []);
  assert.deepEqual(result.ignoredBrowsers, []);
});

test('check applies allow entries', () => {
  const result = binding.check('structuredClone(1);', {
    filename: '/p/src/a.js',
    targets: TARGETS,
    allow: [{ feature: 'api.structuredClone', files: ['src/**'], baseDir: '/p' }],
  });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.usedAllow, [0]);
});

test('check throws on a syntax error', () => {
  assert.throws(() => binding.check('const = ;', { filename: 'broken.js', targets: TARGETS }), /broken\.js/);
});

test('validateAllow reports unknown and native features', () => {
  assert.deepEqual(
    binding.validateAllow([{ feature: 'api.DoesNotExist' }, { feature: 'javascript.builtins.Array.at' }], TARGETS),
    [
      { index: 0, kind: 'unknown-feature' },
      { index: 1, kind: 'native-in-targets' },
    ],
  );
});

test('bcdVersion names the data version', () => {
  assert.equal(binding.bcdVersion(), '8.1.4');
});

test('columns are UTF-16 units across the whole call', () => {
  // 🐈‍⬛ is four UTF-16 units: a surrogate pair, a zero-width joiner and one more character.
  const result = binding.check('const s = "Мяу 🐈‍⬛"; structuredClone(s);', { filename: 'a.js', targets: TARGETS });
  assert.deepEqual(result.findings[0].start, { line: 1, column: 22 });
});
