import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { AllowConfigError, check, createChecker, isCheckable } from '../src-js/index.ts';

const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

test('a checker checks many files with one set of targets and allow entries', () => {
  const checker = createChecker({ targets: TARGETS, allow: ['javascript.builtins.Object.groupBy'] });
  const first = checker.check('structuredClone(1);', '/p/a.js');
  assert.deepEqual(
    first.findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
  const second = checker.check('Object.groupBy(a, f); structuredClone(1);', '/p/b.ts');
  assert.deepEqual(
    second.findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
  assert.deepEqual(second.usedAllow, [0]);
  assert.deepEqual(second.ignoredBrowsers, []);
  assert.equal(second.parseError, undefined);
});

test('a checker gives the result of check()', () => {
  const source = 'const s = "Мяу"; structuredClone(s); [1].toSorted(); class A { static {} }';
  const options = { targets: 'Chrome >= 90', allow: [] };
  assert.deepEqual(createChecker(options).check(source, '/p/a.js'), check(source, { filename: '/p/a.js', ...options }));
});

test('a syntax error is in the result, not thrown', () => {
  const checker = createChecker({ targets: TARGETS });
  const result = checker.check('const a = 1;\nconst = ;', '/p/broken.js');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.usedAllow, []);
  assert.equal(result.parseError?.kind, 'syntax');
  assert.equal(result.parseError?.line, 2);
  assert.equal(result.parseError?.column, 6);
  assert.ok(result.parseError?.message, 'the message is not empty');
  assert.doesNotMatch(result.parseError?.message ?? '', /broken\.js|2:7/, 'the message holds no position');
});

test('an unknown file extension is an unsupported file, not a syntax error', () => {
  const checker = createChecker({ targets: TARGETS });
  for (const [filename, named] of [
    ['/p/a.vue', '".vue"'],
    ['/p/a.ts?v=123', '".ts?v=123"'],
  ] as const) {
    const result = checker.check('<template></template>', filename);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(Object.keys(result.parseError ?? {}).sort(), ['kind', 'message'], 'no position');
    assert.equal(result.parseError?.kind, 'unsupported-file');
    assert.ok(result.parseError?.message.includes(named), result.parseError?.message);
    assert.ok(!result.parseError?.message.includes('/p/'), 'the message does not repeat the filename');
  }
});

test('isCheckable tells the files that a checker can parse', () => {
  for (const filename of ['/p/a.js', '/p/a.mjs', '/p/a.cts', '/p/a.tsx', '/p/A.JS', '/p/a.d.ts']) {
    assert.equal(isCheckable(filename), true, filename);
  }
  // A bundler id with a query is no file name: the adapter strips the query first.
  for (const filename of ['/p/a.vue', '/p/a.css', '/p/Makefile', '/p/a.ts?v=123']) {
    assert.equal(isCheckable(filename), false, filename);
  }
});

test('a range is UTF-16 offsets into the source', () => {
  // 🐈‍⬛ is four UTF-16 units: a surrogate pair, a zero-width joiner and one more character.
  const source = '﻿const s = "Мяу 🐈‍⬛";\nstructuredClone(s);';
  const [finding] = createChecker({ targets: TARGETS }).check(source, '/p/a.js').findings;
  assert.ok(finding);
  assert.equal(source.slice(...finding.range), 'structuredClone');
  // Columns skip the byte order mark, as ESLint does; the range indexes the string as given.
  assert.deepEqual(finding.start, { line: 2, column: 0 });
  assert.deepEqual(finding.range, [23, 38]);
});

test('a heuristic finding names the other features that the allow list accepts', () => {
  const checker = createChecker({ targets: TARGETS });
  const [heuristic] = checker.check('list.toSorted();', '/p/a.js').findings;
  assert.ok(heuristic);
  assert.equal(heuristic.confidence, 'heuristic');
  assert.ok(heuristic.alternatives.length > 0);
  assert.ok(!heuristic.alternatives.includes(heuristic.feature));
  // Each alternative suppresses the finding.
  for (const alternative of heuristic.alternatives) {
    const allowed = createChecker({ targets: TARGETS, allow: [alternative] }).check('list.toSorted();', '/p/a.js');
    assert.deepEqual(allowed.findings, [], alternative);
  }
  const [exact] = checker.check('structuredClone(1);', '/p/a.js').findings;
  assert.deepEqual(exact?.alternatives, []);
});

test('allow takes feature ids and entries; relative files resolve against baseDir', () => {
  const checker = createChecker({
    targets: TARGETS,
    baseDir: '/p',
    allow: [
      'javascript.builtins.Object.groupBy',
      { feature: 'api.structuredClone', files: 'src/legacy/**' },
      { feature: 'javascript.builtins.Intl.Segmenter', files: ['**/*.ts'], baseDir: '/other' },
    ],
  });
  const source = 'Object.groupBy(a, f); structuredClone(1); new Intl.Segmenter();';
  assert.deepEqual(
    checker.check(source, '/p/src/legacy/a.js').findings.map(finding => finding.feature),
    ['javascript.builtins.Intl.Segmenter'],
  );
  assert.deepEqual(
    checker.check(source, '/other/x.ts').findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
});

test('a relative baseDir resolves against the process directory', () => {
  const file = `${process.cwd()}/src/a.js`;
  for (const options of [
    { allow: [{ feature: 'api.structuredClone', files: 'src/**', baseDir: '.' }] },
    { allow: [{ feature: 'api.structuredClone', files: 'src/**' }], baseDir: '.' },
  ]) {
    const checker = createChecker({ targets: TARGETS, ...options });
    assert.deepEqual(checker.check('structuredClone(1);', file).findings, [], JSON.stringify(options));
  }
});

test('relative files of an entry without baseDir resolve against the process directory', () => {
  const checker = createChecker({ targets: TARGETS, allow: [{ feature: 'api.structuredClone', files: ['src/**'] }] });
  assert.deepEqual(checker.check('structuredClone(1);', `${process.cwd()}/src/a.js`).findings, []);
});

function thrown(run: () => unknown): Error & { code?: unknown } {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('expected an error');
}

test('invalid targets throw COMPATGATE_TARGETS', () => {
  const error = thrown(() => createChecker({ targets: 'Chrom >= 97' }));
  assert.equal(error.code, 'COMPATGATE_TARGETS');
  assert.match(error.message, /Chrom >= 97/);
});

test('an invalid allow entry throws COMPATGATE_ALLOW', () => {
  const glob = thrown(() => createChecker({ targets: TARGETS, allow: [{ feature: 'api.a', files: ['src/[a'] }] }));
  assert.equal(glob.code, 'COMPATGATE_ALLOW');
  assert.match(glob.message, /api\.a/);
  // The shape is checked in JavaScript, with the same code.
  // @ts-expect-error not an entry
  const shape = thrown(() => createChecker({ targets: TARGETS, allow: [{ feature: 'api.a', reason: 'x' }] }));
  assert.ok(shape instanceof AllowConfigError);
  assert.equal(shape.code, 'COMPATGATE_ALLOW');
  assert.match(shape.message, /allow\[0\]/);
});

test('checkers in several workers check at the same time', async () => {
  const source = 'structuredClone(1);\nlist.toSorted();\nconst = ;';
  const files = Array.from({ length: 200 }, (_, index) =>
    index % 3 === 2 ? 'const = ;' : `${'x;\n'.repeat(index)}${source.split('\n')[index % 3]}`,
  );
  const checker = createChecker({ targets: TARGETS, allow: ['api.ResizeObserver'] });
  const expected = files.map((file, index) => checker.check(file, `/p/${index}.js`));
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ createChecker }) => {
      const checker = createChecker({ targets: workerData.targets, allow: ['api.ResizeObserver'] });
      parentPort.postMessage(workerData.files.map((file, index) => checker.check(file, '/p/' + index + '.js')));
    });
  `;
  const module = new URL('../src-js/index.ts', import.meta.url).href;
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker(code, { eval: true, workerData: { module, targets: TARGETS, files } });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  );
  for (const result of results) {
    assert.deepEqual(result, expected);
  }
});
