import { test } from 'node:test';
import assert from 'node:assert/strict';
import browserslist from 'browserslist';

import * as binding from '../binding.js';
const TARGETS = browserslist('Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115');

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
  assert.deepEqual(result.suppressed, []);
  assert.equal('ignoredBrowsers' in result, false);
});

test('check applies allow entries', () => {
  const result = check('structuredClone(1);', '/p/src/a.js', TARGETS, [
    { feature: 'api.structuredClone', files: ['src/**'], baseDir: '/p' },
  ]);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.suppressed, [{ index: 0, kind: 'api' }]);
});

test('check returns a syntax error in the result', () => {
  const result = check('const = ;', 'broken.js');
  assert.deepEqual(result.findings, []);
  assert.equal(result.parseError?.kind, 'syntax');
  assert.equal(result.parseError?.line, 1);
  assert.equal(result.parseError?.column, 6);
});

test('a configuration error carries its code', () => {
  assert.throws(() => new binding.Checker(['op_mini all']), {
    code: 'COMPATGATE_TARGETS',
    message: /op_mini all: selects no browser with compatibility data/,
  });
  assert.throws(() => new binding.Checker(['chrome']), { code: 'COMPATGATE_TARGETS', message: /"chrome"/ });
  assert.throws(() => new binding.Checker(TARGETS, [{ feature: 'api.a', files: ['src/**'] }]), {
    code: 'COMPATGATE_ALLOW',
    message: /needs the directory/,
  });
});

test('a checker reports unknown and native features of its entries', () => {
  const checker = new binding.Checker(TARGETS, [
    { feature: 'api.DoesNotExist' },
    { feature: 'javascript.builtins.Array.at' },
    { feature: 'api.structuredClone' },
    { feature: 'api.fetchh' },
  ]);
  // The suggestion is absent, not undefined, when there is none.
  assert.deepEqual(checker.issues(), [
    { index: 0, kind: 'unknown-feature' },
    { index: 1, kind: 'native-in-targets' },
    { index: 3, kind: 'unknown-feature', suggestion: 'api.fetch' },
  ]);
  assert.deepEqual(new binding.Checker(TARGETS).issues(), []);
});

test('a checker takes the browsers in the form of browserslist', () => {
  const result = new binding.Checker(['chrome 120', 'chrome 97', 'safari TP', 'safari 15.2-15.3']).check(
    'structuredClone(1);',
    'a.js',
  );
  assert.deepEqual(result.findings[0]?.unsupported, [
    { browser: 'chrome', target: '97', since: '98' },
    { browser: 'safari', target: '15.2', since: '15.4' },
  ]);
});

test('a checker names the browsers of the targets without data, except the ones that BCD lacks by definition', () => {
  assert.deepEqual(new binding.Checker(TARGETS).ignoredBrowsers, []);
  assert.deepEqual(
    new binding.Checker(['chrome 97', 'op_mini all', 'and_uc 15.5', 'and_qq 14.9', 'kaios 3.0-3.1', 'ie 11'])
      .ignoredBrowsers,
    ['ie'],
  );
});

test('bcdVersion names the data version', () => {
  assert.equal(binding.bcdVersion(), '8.1.4');
});

test('columns are UTF-16 units across the whole call', () => {
  // 🐈‍⬛ is four UTF-16 units: a surrogate pair, a zero-width joiner and one more character.
  const result = check('const s = "Мяу 🐈‍⬛"; structuredClone(s);', 'a.js');
  assert.deepEqual(result.findings[0]?.start, { line: 1, column: 22 });
});

test('partial findings carry the BCD note', () => {
  const result = check('new BarcodeDetector();', 'a.js', browserslist('Chrome >= 97'));
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
