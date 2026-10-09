import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as binding from '../binding.js';
const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

function check(source: string, filename: string, targets = TARGETS, allow?: binding.AllowEntryInput[]) {
  return new binding.Checker(targets, allow).check(source, filename);
}

test('check returns findings with readable versions', () => {
  const result = check('structuredClone(1);', 'a.js');
  assert.deepEqual(result.findings, [
    {
      feature: 'api.structuredClone',
      kind: 'api',
      confidence: 'exact',
      alternatives: [],
      start: { line: 1, column: 0 },
      end: { line: 1, column: 15 },
      range: [0, 15],
      unsupported: [{ browser: 'chrome', target: '97', since: '98' }],
    },
  ]);
  assert.deepEqual(result.usedAllow, []);
  assert.deepEqual(result.ignoredBrowsers, []);
});

test('check applies allow entries', () => {
  const result = check('structuredClone(1);', '/p/src/a.js', TARGETS, [
    { feature: 'api.structuredClone', files: ['src/**'], baseDir: '/p' },
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.usedAllow, [0]);
});

test('check returns a syntax error in the result', () => {
  const result = check('const = ;', 'broken.js');
  assert.deepEqual(result.findings, []);
  assert.equal(result.parseError?.kind, 'syntax');
  assert.equal(result.parseError?.line, 1);
  assert.equal(result.parseError?.column, 6);
});

test('a configuration error carries its code', () => {
  assert.throws(() => new binding.Checker('Chrom >= 97'), { code: 'COMPATGATE_TARGETS' });
  assert.throws(() => new binding.Checker(TARGETS, [{ feature: 'api.a', files: ['src/**'] }]), {
    code: 'COMPATGATE_ALLOW',
    message: /needs the directory/,
  });
  assert.throws(() => binding.validateAllow([], 'Chrom >= 97'), { code: 'COMPATGATE_TARGETS' });
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
  const result = check('const s = "Мяу 🐈‍⬛"; structuredClone(s);', 'a.js');
  assert.deepEqual(result.findings[0].start, { line: 1, column: 22 });
});

test('partial findings carry the BCD note', () => {
  const result = check('new BarcodeDetector();', 'a.js', 'Chrome >= 97');
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding?.confidence, 'partial');
  assert.match(finding?.unsupported[0]?.note ?? '', /ChromeOS/);
});

test('a prototype method is a heuristic finding', () => {
  const result = check('list.toSorted();', 'a.js');
  assert.deepEqual(
    result.findings.map(finding => [finding.feature, finding.confidence]),
    [['javascript.builtins.Array.toSorted', 'heuristic']],
  );
});

test('a prototype method of a literal is an exact finding', () => {
  const result = check('[3, 1].toSorted();', 'a.js');
  assert.deepEqual(
    result.findings.map(finding => [finding.feature, finding.confidence, finding.alternatives]),
    [['javascript.builtins.Array.toSorted', 'exact', []]],
  );
});
