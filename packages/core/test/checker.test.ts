import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { sep } from 'node:path';

import { FAKE_ROOT, fakePath } from '@compatgate/test-utils';
import { createChecker } from './checker.ts';
import { AllowConfigError, ConfigError, OptionsError, TargetsConfigError, isCheckable } from '../src-js/index.ts';
import { check } from './resolve.ts';

const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

test('a checker checks many files with one set of targets and allow entries', () => {
  const checker = createChecker({ targets: TARGETS, allow: ['javascript.builtins.Object.groupBy'] });
  const first = checker.check('structuredClone(1);', fakePath('p', 'a.js'));
  assert.deepEqual(
    first.findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
  const second = checker.check('Object.groupBy(a, f); structuredClone(1);', fakePath('p', 'b.ts'));
  assert.deepEqual(
    second.findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
  assert.deepEqual(second.suppressed, [{ index: 0, kind: 'builtin' }]);
  assert.deepEqual(checker.ignoredBrowsers, []);
  assert.deepEqual(checker.issues(), []);
  assert.equal(second.parseError, undefined);
});

test('a checker tells the kinds of the findings that each used entry suppressed', () => {
  const lookbehind = 'javascript.regular_expressions.lookbehind_assertion';
  const checker = createChecker({ targets: TARGETS, allow: [lookbehind, 'api.ResizeObserver', 'api.structuredClone'] });
  const result = checker.check('structuredClone(/(?<=a)b/);', fakePath('p', 'a.js'));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.suppressed, [
    { index: 0, kind: 'syntax' },
    { index: 2, kind: 'api' },
  ]);
  assert.deepEqual(checker.check('const = ;', fakePath('p', 'b.js')).suppressed, []);
});

test('suppressed names each kind of an entry once, ordered by the index', () => {
  const allow = [
    'javascript.builtins.Intl.Segmenter',
    'javascript.regular_expressions.lookbehind_assertion',
    'api.structuredClone',
    'javascript.builtins.Array.toSorted',
  ];
  const checker = createChecker({ targets: TARGETS, allow });
  const source = 'structuredClone(/(?<=a)b/); [].toSorted(); list.toSorted(); new Intl.Segmenter(); /(?<=c)d/;';
  const result = checker.check(source, fakePath('p', 'a.js'));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.suppressed.map(item => item.index),
    [0, 1, 2, 3],
  );
  assert.deepEqual(
    result.suppressed.map(item => item.kind),
    ['builtin', 'syntax', 'api', 'builtin'],
  );
});

test('the checker of a configuration gives the result of the binding with the messages', () => {
  const source = 'const s = "Мяу"; structuredClone(s); [1].toSorted(); class A { static {} }';
  const options = { targets: 'Chrome >= 90', allow: [] };
  const result = check(source, { filename: fakePath('p', 'a.js'), ...options });
  const core = createChecker(options).check(source, fakePath('p', 'a.js'));
  const messages = result.findings.map(finding => finding.message);
  assert.deepEqual(result, {
    ...core,
    findings: core.findings.map((finding, i) => ({ ...finding, message: messages[i] })),
  });
  assert.equal(result.findings.length, 3);
  for (const finding of result.findings) {
    assert.match(
      finding.message,
      new RegExp(`^${finding.feature.replaceAll('.', '\\.')} is not supported in Chrome 90`),
    );
  }
});

test('a syntax error is in the result, not thrown', () => {
  const checker = createChecker({ targets: TARGETS });
  const result = checker.check('const a = 1;\nconst = ;', fakePath('p', 'broken.js'));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.suppressed, []);
  assert.equal(result.parseError?.kind, 'syntax');
  assert.equal(result.parseError?.line, 2);
  assert.equal(result.parseError?.column, 6);
  assert.ok(result.parseError?.message, 'the message is not empty');
  assert.doesNotMatch(result.parseError?.message ?? '', /broken\.js|2:7/, 'the message holds no position');
});

test('an unknown file extension is an unsupported file, not a syntax error', () => {
  const checker = createChecker({ targets: TARGETS });
  for (const [filename, named] of [
    [fakePath('p', 'a.vue'), '".vue"'],
    [fakePath('p', 'a.ts?v=123'), '".ts?v=123"'],
  ] as const) {
    const result = checker.check('<template></template>', filename);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(Object.keys(result.parseError ?? {}).sort(), ['kind', 'message'], 'no position');
    assert.equal(result.parseError?.kind, 'unsupported-file');
    assert.ok(result.parseError?.message.includes(named), result.parseError?.message);
    assert.ok(!result.parseError?.message.includes(FAKE_ROOT), 'the message does not repeat the filename');
  }
});

test('isCheckable tells the files that a checker can parse', () => {
  for (const filename of [
    fakePath('p', 'a.js'),
    fakePath('p', 'a.mjs'),
    fakePath('p', 'a.cts'),
    fakePath('p', 'a.tsx'),
    fakePath('p', 'A.JS'),
    fakePath('p', 'a.d.ts'),
  ]) {
    assert.equal(isCheckable(filename), true, filename);
  }
  // A bundler id with a query is no file name: the adapter strips the query first.
  for (const filename of [
    fakePath('p', 'a.vue'),
    fakePath('p', 'a.css'),
    fakePath('p', 'Makefile'),
    fakePath('p', 'a.ts?v=123'),
  ]) {
    assert.equal(isCheckable(filename), false, filename);
  }
});

test('a range is UTF-16 offsets into the source', () => {
  // 🐈‍⬛ is four UTF-16 units: a surrogate pair, a zero-width joiner and one more character.
  const source = '﻿const s = "Мяу 🐈‍⬛";\nstructuredClone(s);';
  const [finding] = createChecker({ targets: TARGETS }).check(source, fakePath('p', 'a.js')).findings;
  assert.ok(finding);
  assert.equal(source.slice(...finding.range), 'structuredClone');
  // Columns skip the byte order mark, as ESLint does; the range indexes the string as given.
  assert.deepEqual(finding.start, { line: 2, column: 0 });
  assert.deepEqual(finding.range, [23, 38]);
});

test('a heuristic finding names the other features that the allow list accepts', () => {
  const checker = createChecker({ targets: TARGETS });
  const [heuristic] = checker.check('list.toSorted();', fakePath('p', 'a.js')).findings;
  assert.ok(heuristic);
  assert.equal(heuristic.confidence, 'heuristic');
  assert.ok(heuristic.alternatives.length > 0);
  assert.ok(!heuristic.alternatives.includes(heuristic.feature));
  // Each alternative suppresses the finding.
  for (const alternative of heuristic.alternatives) {
    const allowed = createChecker({ targets: TARGETS, allow: [alternative] }).check(
      'list.toSorted();',
      fakePath('p', 'a.js'),
    );
    assert.deepEqual(allowed.findings, [], alternative);
  }
  const [exact] = checker.check('structuredClone(1);', fakePath('p', 'a.js')).findings;
  assert.deepEqual(exact?.alternatives, []);
});

test('allow takes feature ids and entries; relative files resolve against baseDir', () => {
  const checker = createChecker({
    targets: TARGETS,
    baseDir: FAKE_ROOT,
    allow: [
      'javascript.builtins.Object.groupBy',
      { feature: 'api.structuredClone', files: 'src/legacy/**' },
      { feature: 'javascript.builtins.Intl.Segmenter', files: ['**/*.ts'], baseDir: fakePath('other') },
    ],
  });
  const source = 'Object.groupBy(a, f); structuredClone(1); new Intl.Segmenter();';
  assert.deepEqual(
    checker.check(source, fakePath('p', 'src', 'legacy', 'a.js')).findings.map(finding => finding.feature),
    ['javascript.builtins.Intl.Segmenter'],
  );
  assert.deepEqual(
    checker.check(source, fakePath('other', 'x.ts')).findings.map(finding => finding.feature),
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

test('targets without data are a TargetsConfigError with the error of the binding as the cause', () => {
  const error = thrown(() => createChecker({ targets: 'op_mini all' }));
  assert.ok(error instanceof TargetsConfigError);
  assert.equal(error.code, 'COMPATGATE_TARGETS');
  assert.match(error.message, /op_mini all: selects no browser with compatibility data/);
  assert.equal((error.cause as { code?: string }).code, 'COMPATGATE_TARGETS');
});

test('every error of a config or of the options is a ConfigError', () => {
  const errors = [
    thrown(() => createChecker({ targets: 'Chrom >= 97' })),
    thrown(() => createChecker({ targets: 'op_mini all' })),
    thrown(() => createChecker({ targets: TARGETS, allow: [{ feature: 'api.a', files: ['src/[a'] }] })),
    thrown(() => createChecker({ targets: 97 } as never)),
  ];
  assert.deepEqual(
    errors.map(error => error.constructor),
    [TargetsConfigError, TargetsConfigError, AllowConfigError, OptionsError],
  );
  for (const error of errors) {
    assert.ok(error instanceof ConfigError, error.name);
    assert.deepEqual([error.watch, error.missing], [[], []]);
  }
});

test('targets of a wrong type throw COMPATGATE_OPTIONS', () => {
  for (const targets of [undefined, 97, ['Chrome >= 97']]) {
    const error = thrown(() => createChecker({ targets } as never));
    assert.equal(error.code, 'COMPATGATE_OPTIONS', String(targets));
    assert.equal(error.message, 'targets: expected a string');
  }
});

test('an invalid allow entry throws COMPATGATE_ALLOW', () => {
  const glob = thrown(() => createChecker({ targets: TARGETS, allow: [{ feature: 'api.a', files: ['src/[a'] }] }));
  assert.equal(glob.code, 'COMPATGATE_ALLOW');
  assert.match(glob.message, /api\.a/);
  // The glob fails in the binding: the error of the binding is the cause.
  assert.ok(glob instanceof AllowConfigError);
  assert.equal((glob.cause as { code?: string }).code, 'COMPATGATE_ALLOW');
  assert.equal((glob.cause as Error).message, glob.message);
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
  const name = (index: number) => fakePath('p', `${index}.js`);
  const names = files.map((_, index) => name(index));
  const expected = files.map((file, index) => checker.check(file, name(index)));
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ createChecker }) => {
      const checker = createChecker({ targets: workerData.targets, allow: ['api.ResizeObserver'] });
      parentPort.postMessage(workerData.files.map((file, index) => checker.check(file, workerData.names[index])));
    });
  `;
  const module = new URL('./checker.ts', import.meta.url).href;
  const results = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker(code, { eval: true, workerData: { module, targets: TARGETS, files, names } });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  );
  for (const result of results) {
    assert.deepEqual(result, expected);
  }
});

test('`parseAs` selects the parser, and the filename matches the `files` of allow entries', () => {
  const checker = createChecker({
    targets: TARGETS,
    allow: [{ feature: 'api.structuredClone', files: 'src/*.vue', baseDir: FAKE_ROOT }],
  });
  const component = checker.check(
    'structuredClone(1);',
    fakePath('p', 'src', 'App.vue'),
    fakePath('p', 'src', 'App.vue.js'),
  );
  assert.equal(component.parseError, undefined);
  assert.deepEqual(component.findings, []);
  assert.deepEqual(component.suppressed, [{ index: 0, kind: 'api' }]);
  const typed = checker.check(
    'const n: number = 1;',
    fakePath('p', 'src', 'App.vue'),
    fakePath('p', 'src', 'App.vue.ts'),
  );
  assert.equal(typed.parseError, undefined);
  const other = checker.check(
    'structuredClone(1);',
    fakePath('p', 'lib', 'App.vue'),
    fakePath('p', 'src', 'App.vue.js'),
  );
  assert.deepEqual(
    other.findings.map(finding => finding.feature),
    ['api.structuredClone'],
  );
});

test('a `parseAs` without a parser is an unsupported file', () => {
  const result = createChecker({ targets: TARGETS }).check('x;', fakePath('p', 'a.js'), fakePath('p', 'a.css'));
  assert.equal(result.parseError?.kind, 'unsupported-file');
});

test('check() takes `parseAs` too', () => {
  const result = check('const n: number = structuredClone(1);', {
    filename: fakePath('p', 'src', 'App.vue'),
    parseAs: fakePath('p', 'src', 'App.vue.ts'),
    targets: TARGETS,
    allow: [{ feature: 'api.structuredClone', files: 'src/App.vue', baseDir: FAKE_ROOT }],
  });
  assert.equal(result.parseError, undefined);
  assert.deepEqual(result.suppressed, [{ index: 0, kind: 'api' }]);
});

// ESLint passes `D:\p\src\a.js` on Windows; Vite and Rollup pass `D:/p/src/a.js`. Both are absolute paths there.
test(
  'on Windows a path with either separator matches the files of allow entries',
  {
    skip: process.platform !== 'win32',
  },
  () => {
    const checker = createChecker({
      targets: TARGETS,
      baseDir: FAKE_ROOT,
      allow: [{ feature: 'api.structuredClone', files: 'src/**' }],
    });
    for (const separator of ['\\', '/']) {
      const path = (...segments: string[]) =>
        fakePath(...segments)
          .split(sep)
          .join(separator);
      assert.deepEqual(checker.check('structuredClone(1);', path('p', 'src', 'a.js')).findings, [], separator);
      assert.deepEqual(
        checker.check('structuredClone(1);', path('p', 'lib', 'a.js')).findings.map(finding => finding.feature),
        ['api.structuredClone'],
        separator,
      );
    }
  },
);
