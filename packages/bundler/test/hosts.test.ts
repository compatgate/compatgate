import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import * as esbuild from 'esbuild';
import { rollup } from 'rollup';

import { createProject, editFile, toSlashes } from '@compatgate/test-utils';
import { compatgateEsbuild, compatgateRollup } from '../src/index.ts';
import { clearProcessMessages } from '../src/plugin.ts';
import { TARGETS } from './helpers.ts';
import {
  esbuildHost,
  eventually,
  rolldownHost,
  rollupHost,
  serveVite,
  viteHost,
  watchRollup,
  type Host,
} from './hosts.ts';

// TypeScript lines before each finding: after the types are removed, a finding sits on another line of the
// transpiled module. `Intl.Segmenter` is on line 6 of the source, the lookbehind assertion on line 3.
const PROJECT = {
  '.browserslistrc': TARGETS,
  'src/index.ts': [
    "import { split } from './split.ts';",
    "import { last } from './match.ts';",
    "import { clean } from './clean.ts';",
    "console.log(split('a b'), last('ab'), clean);",
    '',
  ].join('\n'),
  'src/split.ts': [
    'interface Options {',
    '  locale: string;',
    '}',
    '',
    "export const split = (text: string, options: Options = { locale: 'en' }) =>",
    '  [...new Intl.Segmenter(options.locale).segment(text)];',
    '',
  ].join('\n'),
  'src/match.ts': 'type Text = string;\n\nexport const last = (text: Text) => /(?<=a)b/.exec(text);\n',
  'src/clean.ts': 'export const clean: number = 1;\n',
};

// `Object.groupBy` on line 8, column 16.
const COMPONENT = [
  '<template>',
  '  <div>{{ groups }}</div>',
  '</template>',
  '',
  '<script setup lang="ts">',
  'interface Item { kind: string }',
  "const items: Item[] = [{ kind: 'a' }];",
  'const groups = Object.groupBy(items, (item: Item) => item.kind);',
  '</script>',
  '',
].join('\n');

const SEGMENTER = 'javascript.builtins.Intl.Segmenter';
const LOOKBEHIND = 'javascript.regular_expressions.lookbehind_assertion';
// Every target supports it.
const NATIVE = 'api.fetch';
// Firefox 115 lacks it, and no module uses it.
const UNUSED = 'api.Highlight';
// Firefox 115 lacks it too, and no module uses it.
const OTHER_UNUSED = 'api.CloseWatcher';
const SPLIT = /\[compatgate\/exact\] src\/split\.ts:6:11: javascript\.builtins\.Intl\.Segmenter is not supported/;
// The finding starts at `(?<=`, inside the literal: Vite and Rollup map the literal as one segment of the map.
const MATCH = /\[compatgate\/exact\] src\/match\.ts:3:38: javascript\.regular_expressions\.lookbehind_assertion/;
const COMPATGATE = /\[compatgate(?:\/(?:exact|heuristic|partial))?\]/;

// Seven places of a feature that Chrome 97 supports only in part, in two modules.
const PARTIAL = 'api.BarcodeDetector.BarcodeDetector';
const PARTIAL_PATTERN = PARTIAL.replaceAll('.', '\\.');
const PARTIAL_PROJECT = {
  'src/index.ts': "import './a.ts';\nimport './b.ts';\n",
  'src/a.ts': 'new BarcodeDetector();\n'.repeat(4),
  'src/b.ts': 'new BarcodeDetector();\n'.repeat(3),
};
const PARTIAL_OPTIONS = { targets: 'Chrome >= 97' };
const SUMMARY = new RegExp(
  `\\[compatgate/partial\\] ${PARTIAL_PATTERN} in 7 places, the first 5: src/a\\.ts:1:5, src/a\\.ts:2:5, ` +
    `src/a\\.ts:3:5, src/a\\.ts:4:5, src/b\\.ts:1:5\\. ${PARTIAL_PATTERN} is only partially supported`,
);
/** The findings of compatgate among the warnings. */
const findingsOf = (warnings: readonly string[]) => warnings.filter(warning => /\[compatgate\/\w+\]/.test(warning));

/** The warnings of compatgate without what the bundler puts before them, such as the name of the plugin in Vite. */
function compatgateWarnings(warnings: readonly string[]): string[] {
  return warnings
    .filter(warning => warning.includes('[compatgate]'))
    .map(warning => warning.slice(warning.indexOf('[compatgate]') + '[compatgate] '.length).trimEnd());
}

// The warnings about a config show once per process: each test starts anew.
beforeEach(() => clearProcessMessages());

/** The lines of compatgate in a message of the bundler. */
function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n').filter(line => /\[compatgate\/\w+\] src\//.test(line));
}

for (const host of [viteHost, rollupHost, rolldownHost, esbuildHost] satisfies Host[]) {
  describe(host.name, () => {
    test('the findings of two modules are one error of the build, at the lines of the source', async () => {
      const { error, warnings } = await host.build(createProject(PROJECT));
      assert.ok(error, 'the build fails');
      const found = lines(error);
      assert.equal(found.length, 2, error);
      assert.ok(
        found.some(line => SPLIT.test(line)),
        error,
      );
      assert.ok(
        found.some(line => MATCH.test(line)),
        error,
      );
      assert.match(error, /compatgate found 2 errors/);
      assert.deepEqual(
        warnings.filter(warning => COMPATGATE.test(warning)),
        [],
      );
    });

    test('a severity of `warn` makes the findings warnings, and the build succeeds', async () => {
      const { error, warnings } = await host.build(createProject(PROJECT), { severity: { exact: 'warn' } });
      assert.equal(error, undefined);
      const found = findingsOf(warnings);
      assert.equal(found.length, 2, warnings.join('\n---\n'));
      assert.ok(found.some(warning => SPLIT.test(warning)));
    });

    test('allow entries suppress the findings', async () => {
      const root = createProject(PROJECT);
      assert.equal(lines((await host.build(root)).error).length, 2);
      const { error, warnings } = await host.build(root, { allow: [SEGMENTER, LOOKBEHIND] });
      assert.equal(error, undefined);
      assert.deepEqual(
        warnings.filter(warning => COMPATGATE.test(warning)),
        [],
      );
    });

    test('a config error is one error of the build with the text of the core', async () => {
      const root = createProject({ ...PROJECT, 'compatgate.jsonc': '{ "allow": [{ "feature": 1 }] }' });
      const { error } = await host.build(root);
      assert.equal(error?.match(/allow\[0\]: expected a feature id/g)?.length, 1, error);
      assert.match(error ?? '', /compatgate found 1 error:/);
    });

    test('an own entry that every target supports is a warning; an entry of a base is not', async () => {
      const root = createProject({
        ...PROJECT,
        'base.jsonc': `{ "allow": ["${NATIVE}"] }`,
        'compatgate.jsonc': `{ "extends": "./base.jsonc", "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "${NATIVE}"] }`,
      });
      const { error, warnings } = await host.build(root);
      assert.equal(error, undefined);
      assert.deepEqual(compatgateWarnings(warnings), [
        `compatgate.jsonc, allow[2]: every target browser supports "${NATIVE}". Remove the entry.`,
      ]);
    });

    test('an unknown feature id of an own entry is an error of the build', async () => {
      const root = createProject({
        ...PROJECT,
        'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "api.Fetch"] }`,
      });
      const { error } = await host.build(root);
      assert.match(
        error ?? '',
        /compatgate\.jsonc, allow\[2\]: unknown feature "api\.Fetch"\. A feature id is a path in @mdn\/browser-compat-data/,
      );
      assert.match(error ?? '', /compatgate found 1 error:/);
    });

    test('an unknown feature id of a base entry is a warning', async () => {
      const root = createProject({
        ...PROJECT,
        'config/base.jsonc': '{ "allow": ["api.BaseTypo"] }',
        'compatgate.jsonc': `{ "extends": "./config/base.jsonc", "allow": ["${SEGMENTER}", "${LOOKBEHIND}"] }`,
      });
      const { error, warnings } = await host.build(root);
      assert.equal(error, undefined);
      const found = warnings.filter(warning => warning.includes('[compatgate]'));
      assert.equal(found.length, 1, warnings.join('\n'));
      assert.match(
        found[0] ?? '',
        /config\/base\.jsonc, allow\[0\]: unknown feature "api\.BaseTypo"\. compatgate ignores the entry\./,
      );
    });

    test(`own entries that suppressed nothing are ${host.name === 'esbuild' ? 'not reported' : 'one warning at the end'}`, async () => {
      const root = createProject({
        ...PROJECT,
        'base.jsonc': `{ "allow": ["api.CloseWatcher"] }`,
        'compatgate.jsonc': `{ "extends": "./base.jsonc", "allow": ["${SEGMENTER}", "${UNUSED}", "${LOOKBEHIND}"] }`,
      });
      const { error, warnings } = await host.build(root);
      assert.equal(error, undefined);
      // esbuild gives a plugin no list of the modules of the build.
      const expected =
        host.name === 'esbuild'
          ? []
          : [
              `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${UNUSED}". Remove them unless other code needs them`,
            ];
      assert.deepEqual(compatgateWarnings(warnings), expected);
    });
  });
}

for (const host of [viteHost, rollupHost, rolldownHost] satisfies Host[]) {
  test(`${host.name}: seven places of one partial feature are one warning at the end of the build`, async () => {
    const { error, warnings } = await host.build(createProject(PARTIAL_PROJECT), PARTIAL_OPTIONS);
    assert.equal(error, undefined);
    const found = findingsOf(warnings);
    assert.equal(found.length, 1, warnings.join('\n'));
    assert.match(found[0] ?? '', SUMMARY);
  });
}

test('esbuild: partial findings are warnings one by one', async () => {
  // esbuild gives a plugin no list of the modules of the build: the plugin cannot tell that it saw them all.
  const { error, warnings } = await esbuildHost.build(createProject(PARTIAL_PROJECT), PARTIAL_OPTIONS);
  assert.equal(error, undefined);
  const found = findingsOf(warnings);
  assert.equal(found.length, 7, warnings.join('\n'));
  assert.ok(
    found.every(warning => /^\[compatgate\/partial\] src\/[ab]\.ts:\d+:5: /.test(warning)),
    found.join('\n'),
  );
});

// A class static block, which Safari 16.4 brings: the bundlers lower it for the target `safari15`. A lookbehind
// assertion next to it, which no bundler lowers.
const LOWERED = {
  '.browserslistrc': 'Safari >= 15.6',
  'src/index.ts':
    "import { Counter } from './counter.ts';\nimport { last } from './match.ts';\nconsole.log(Counter, last('ab'));\n",
  'src/counter.ts': 'export class Counter {\n  static count: number;\n  static {\n    Counter.count = 0;\n  }\n}\n',
  'src/match.ts': PROJECT['src/match.ts'],
};
const STATIC_BLOCK = 'javascript.classes.static.initialization_blocks';

for (const host of [viteHost, rollupHost, rolldownHost] satisfies Host[]) {
  test(`${host.name}: an external module does not stop the report of unused entries`, async () => {
    const root = createProject({
      ...PROJECT,
      'src/clean.ts': "export { clean } from './external.ts';\n",
      'src/external.ts': 'export const clean = 1;\n',
      'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${UNUSED}", "${LOOKBEHIND}"] }`,
    });
    const { error, warnings } = await host.build(root, {}, { external: [join(root, 'src/external.ts')] });
    assert.equal(error, undefined);
    assert.equal(compatgateWarnings(warnings).length, 1, warnings.join('\n'));
  });
}

for (const host of [viteHost, rolldownHost, esbuildHost] satisfies Host[]) {
  describe(`${host.name} lowering`, () => {
    test('an entry of syntax that the target of the bundler lowers suppressed nothing', async () => {
      const root = createProject({
        ...LOWERED,
        'compatgate.jsonc': `{ "allow": ["${LOOKBEHIND}", "${STATIC_BLOCK}"] }`,
      });
      const { error, warnings } = await host.build(root, {}, { target: 'safari15' });
      assert.equal(error, undefined);
      const expected =
        host.name === 'esbuild'
          ? []
          : [
              `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${STATIC_BLOCK}". Remove them unless other code needs them`,
            ];
      assert.deepEqual(compatgateWarnings(warnings), expected);
    });

    test('syntax that the target of the bundler lowers is no finding', async () => {
      const { error } = await host.build(createProject(LOWERED), {}, { target: 'safari15' });
      const found = lines(error);
      assert.equal(found.length, 1, error);
      assert.match(found[0] ?? '', MATCH);
    });

    for (const target of [undefined, 'esnext']) {
      test(`syntax is a finding when the target ${target ?? 'of the default'} keeps it`, async () => {
        const { error } = await host.build(createProject(LOWERED), {}, target === undefined ? {} : { target });
        const found = lines(error);
        assert.equal(found.length, 2, error);
        assert.ok(
          found.some(line => line.includes(`src/counter.ts:3:3: ${STATIC_BLOCK}`)),
          error,
        );
      });
    }
  });
}

describe('a missing engine of the lowering', () => {
  test('is one warning of the build, and the syntax findings stay', async t => {
    const root = createProject(LOWERED);
    // Neither the project nor the process directory resolves `rolldown/utils`.
    const cwd = process.cwd();
    process.chdir(root);
    t.after(() => process.chdir(cwd));
    const { error, warnings } = await rolldownHost.build(root, {}, { target: 'safari15' });
    assert.equal(lines(error).length, 2, error);
    const missing = warnings.filter(warning =>
      /\[compatgate\] cannot lower as Rolldown does: .+; syntax findings stay/.test(warning),
    );
    assert.equal(missing.length, 1, warnings.join('\n'));
  });
});

describe('vite', () => {
  test('the dev server lowers the syntax as the build of the client would', async t => {
    const root = createProject(LOWERED);
    const lowering = await serveVite(root, {}, { target: 'safari15' });
    t.after(() => lowering.close());
    assert.equal((await lowering.get('/src/counter.ts')).status, 200);
    assert.equal((await lowering.get('/src/match.ts')).status, 500);

    // The default target of Vite keeps the static block.
    const keeping = await serveVite(root);
    t.after(() => keeping.close());
    const counter = await keeping.get('/src/counter.ts');
    assert.equal(counter.status, 500);
    assert.match(counter.body, new RegExp(`src/counter\\.ts:3:3: ${STATIC_BLOCK.replaceAll('.', '\\.')}`));
  });

  test('the plugin skips the environments of the server, such as SSR', async t => {
    const server = await serveVite(createProject(PROJECT));
    t.after(() => server.close());
    const module = await server.ssrLoad('/src/split.ts');
    assert.equal(typeof module.split, 'function');
  });

  test('a finding in a component with <script setup lang="ts"> points into the .vue file', async () => {
    const root = createProject({
      ...PROJECT,
      'src/index.ts': "import App from './App.vue';\nconsole.log(App);\n",
      'src/App.vue': COMPONENT,
    });
    // plugin-vue gives a source map of a component in a build only when the build makes source maps.
    const mapped = await viteHost.build(root, {}, { vue: true, sourcemap: true });
    const found = lines(mapped.error);
    assert.equal(found.length, 1, mapped.error);
    assert.match(
      found[0] ?? '',
      /^\[compatgate\/exact\] src\/App\.vue:8:16: javascript\.builtins\.Object\.groupBy is not supported/,
    );

    // Without it, the map of the script ends at the code of plugin-vue, not at the .vue file.
    const unmapped = lines((await viteHost.build(root, {}, { vue: true })).error);
    assert.equal(unmapped.length, 1, unmapped.join('\n'));
    assert.match(
      unmapped[0] ?? '',
      /^\[compatgate\/exact\] src\/App\.vue:\d+:\d+ \(position in the transpiled module\): .*groupBy/,
    );
  });

  test('the dev server maps a finding in a component to the .vue file', async t => {
    const root = createProject({ ...PROJECT, 'src/App.vue': COMPONENT });
    const server = await serveVite(root, {}, { vue: true });
    t.after(() => server.close());
    const response = await server.get('/src/App.vue');
    assert.equal(response.status, 500);
    assert.match(response.body, /\[compatgate\/exact\] src\/App\.vue:8:16: javascript\.builtins\.Object\.groupBy/);
  });

  test('a module without a source map shows the position in the transpiled module', async () => {
    // The plugin before compatgate moves the code and gives a map without mappings.
    const banner = {
      name: 'banner',
      transform: (code: string, id: string) =>
        id.endsWith('match.ts') ? { code: `/* banner */\n${code}`, map: { mappings: '' } } : null,
    };
    const { error } = await viteHost.build(createProject(PROJECT), {}, { plugins: [banner] });
    assert.ok(
      lines(error).some(line =>
        /^\[compatgate\/exact\] src\/match\.ts:\d+:\d+ \(position in the transpiled module\): .*lookbehind/.test(line),
      ),
      error,
    );
    assert.ok(
      lines(error).some(line => SPLIT.test(line)),
      error,
    );
  });

  test('the dev server answers a module with a finding with an error, and goes on serving', async t => {
    const root = createProject(PROJECT);
    const server = await serveVite(root);
    t.after(() => server.close());
    const split = await server.get('/src/split.ts');
    assert.equal(split.status, 500);
    assert.match(split.body, SPLIT);
    const clean = await server.get('/src/clean.ts');
    assert.equal(clean.status, 200, clean.body);
    // The module fails again on the next request: the dev server has no end of a build.
    assert.match((await server.get('/src/split.ts')).body, SPLIT);
  });

  test('the dev server reports a config error on every module of the config', async t => {
    const root = createProject({ ...PROJECT, 'compatgate.jsonc': '{ "allow": [{ "feature": 1 }] }' });
    const server = await serveVite(root);
    t.after(() => server.close());
    for (const path of ['/src/split.ts', '/src/clean.ts', '/src/split.ts']) {
      const response = await server.get(path);
      assert.equal(response.status, 500, path);
      assert.match(response.body, /allow\[0\]: expected a feature id/, path);
    }
  });

  test('the dev server reports an unknown feature id of an own entry on every module of the config', async t => {
    const root = createProject({ ...PROJECT, 'compatgate.jsonc': '{ "allow": ["api.Fetch"] }' });
    const server = await serveVite(root);
    t.after(() => server.close());
    for (const path of ['/src/clean.ts', '/src/index.ts', '/src/clean.ts']) {
      const response = await server.get(path);
      assert.equal(response.status, 500, path);
      // The page of the error escapes the quotes.
      assert.match(response.body, /allow\[0\]: unknown feature \\?"api\.Fetch/, path);
    }
  });

  test('an edit of compatgate.jsonc shows in the dev server', async t => {
    const root = createProject({ ...PROJECT, 'compatgate.jsonc': '{ "allow": [] }' });
    const server = await serveVite(root);
    t.after(() => server.close());
    assert.equal((await server.get('/src/split.ts')).status, 500);
    editFile(join(root, 'compatgate.jsonc'), `{ "allow": ["${SEGMENTER}"] }`);
    const fixed = await eventually(async () => (await server.get('/src/split.ts')).status === 200);
    assert.ok(fixed, 'the module passes after the edit');
  });
});

describe('a build that fails for another reason', () => {
  test('keeps its own error, and the findings are a warning', async () => {
    // The module with the finding is the entry: Rolldown stops at the unresolved import before other modules.
    const root = createProject({
      '.browserslistrc': TARGETS,
      'src/index.ts': "import './missing.ts';\nconsole.log(new Intl.Segmenter('en'));\n",
    });
    const { error, warnings } = await rolldownHost.build(root);
    assert.match(error ?? '', /missing\.ts/);
    assert.doesNotMatch(error ?? '', /compatgate found/);
    assert.ok(
      warnings.some(warning => /compatgate found 1 error:/.test(warning)),
      warnings.join('\n'),
    );
  });
});

// The project root of Rollup is the directory of the process. A module outside it keeps its absolute path as the
// bundler gives it: Rollup gives `C:/…` on Windows.
test('Rollup run outside the project names a module by its absolute path', async t => {
  const root = createProject({ 'src/index.js': 'new Intl.Segmenter();\n' });
  const cwd = process.cwd();
  process.chdir(createProject());
  t.after(() => process.chdir(cwd));
  const error = await rollup({
    input: join(root, 'src/index.js'),
    plugins: [compatgateRollup({ targets: TARGETS })],
  }).then(
    () => assert.fail('the build passes'),
    (failure: Error) => failure.message,
  );
  assert.ok(error.includes(`[compatgate/exact] ${toSlashes(join(root, 'src', 'index.js'))}:1:5: `), error);
});

// A config of Rollup may give one plugin to several builds, such as an array of configs with a shared plugin. Each
// build reports the entries that its own code did not use: an entry for the other build is unused in this one.
test('one plugin in two builds of Rollup reports each build by its own modules', async t => {
  const root = createProject({
    'compatgate.jsonc': `{ "allow": ["${SEGMENTER}"] }`,
    'src/a.js': "new Intl.Segmenter('en');\n",
    'src/b.js': 'console.log(1);\n',
  });
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(cwd));
  const plugin = compatgateRollup({ targets: TARGETS });
  const build = async (input: string) => {
    const warnings: string[] = [];
    const bundle = await rollup({
      input: join(root, input),
      plugins: [plugin],
      onwarn: warning => warnings.push(warning.message),
    });
    await bundle.close();
    return compatgateWarnings(warnings);
  };
  const unused = `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${SEGMENTER}". Remove them unless other code needs them`;
  assert.deepEqual(await build('src/a.js'), []);
  assert.deepEqual(await build('src/b.js'), [unused]);
  // The second build leaves nothing behind for the next one.
  assert.deepEqual(await build('src/a.js'), []);
});

describe('rollup watch', () => {
  test('the error of a build names the configs to watch, and the directory of a missing one', async t => {
    // Rollup watches only the files of the error after a failed build. A missing file is watched through a filter
    // on its directory, and chokidar 3 of Rollup reads a directory for one filter at a time: of three missing
    // configs in the project root only the first would show on Linux. The directory itself shows each new file.
    const root = createProject({ '.browserslistrc': TARGETS, 'src/index.js': 'new Intl.Segmenter();\n' });
    // The project root of Rollup is the process directory: only there a new config is watched.
    const cwd = process.cwd();
    process.chdir(root);
    t.after(() => process.chdir(cwd));
    const error = await rollup({ input: join(root, 'src/index.js'), plugins: [compatgateRollup({})] }).then(
      () => assert.fail('the build passes'),
      (failure: { watchFiles?: string[] }) => failure,
    );
    const watched = error.watchFiles ?? [];
    for (const path of [root, join(root, '.browserslistrc'), join(root, 'src/index.js')]) {
      assert.ok(watched.includes(path), `${path} in ${watched.join(', ')}`);
    }
    for (const file of ['compatgate.jsonc', 'browserslist', 'package.json']) {
      assert.ok(!watched.includes(join(root, file)), `${file} in ${watched.join(', ')}`);
    }
  });

  test('a new compatgate.jsonc in the project root shows in the next build', async t => {
    const root = createProject(PROJECT);
    // The project root of Rollup is the process directory, which `watchRollup` sets: only there a new config is
    // watched.
    const watcher = watchRollup(root);
    t.after(() => watcher.close());
    assert.equal(lines((await watcher.next()).error).length, 2);
    await watcher.edit(join(root, 'compatgate.jsonc'), `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}"] }`);
    assert.equal((await watcher.next()).error, undefined);
  });

  test('a rebuild after an edit of one module gives the report of unused entries', async t => {
    const root = createProject({
      ...PROJECT,
      'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "${UNUSED}"] }`,
    });
    const watcher = watchRollup(root);
    t.after(() => watcher.close());
    const report = [
      `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[2] "${UNUSED}". Remove them unless other code needs them`,
    ];
    const first = await watcher.next();
    assert.equal(first.error, undefined);
    assert.deepEqual(compatgateWarnings(first.warnings), report);
    // Rollup takes the other modules from its cache: their records of the first build count.
    await watcher.edit(join(root, 'src/clean.ts'), 'export const clean: number = 2;\n');
    const second = await watcher.next();
    assert.equal(second.error, undefined);
    assert.deepEqual(compatgateWarnings(second.warnings), report);
  });

  test('an edit of compatgate.jsonc checks its modules again, and the report follows it', async t => {
    const root = createProject({
      ...PROJECT,
      'compatgate.jsonc': `{ "allow": ["${LOOKBEHIND}", "${UNUSED}"] }`,
      'src/lib/compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${OTHER_UNUSED}"] }`,
      'src/lib/segment.ts': "export const segment = new Intl.Segmenter('en');\n",
      'src/index.ts': `import { segment } from './lib/segment.ts';\n${PROJECT['src/index.ts']}console.log(segment);\n`,
      'src/split.ts': 'export const split = (text: string) => text.split(" ");\n',
    });
    const watcher = watchRollup(root);
    t.after(() => watcher.close());
    const lib = `src/lib/compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${OTHER_UNUSED}". Remove them unless other code needs them`;
    const first = await watcher.next();
    assert.equal(first.error, undefined);
    assert.deepEqual(
      compatgateWarnings(first.warnings).sort(),
      [
        `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${UNUSED}". Remove them unless other code needs them`,
        lib,
      ].sort(),
    );
    // The modules of the root config are checked again; the module of src/lib comes from the cache.
    await watcher.edit(join(root, 'compatgate.jsonc'), `{ "allow": ["${UNUSED}", "${LOOKBEHIND}"] }`);
    const second = await watcher.next();
    assert.equal(second.error, undefined);
    assert.deepEqual(
      compatgateWarnings(second.warnings).sort(),
      [
        `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${UNUSED}". Remove them unless other code needs them`,
        lib,
      ].sort(),
    );
  });

  test('a module that leaves the build leaves the report of unused entries', async t => {
    const root = createProject({
      ...PROJECT,
      'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "${UNUSED}"] }`,
    });
    const watcher = watchRollup(root);
    t.after(() => watcher.close());
    assert.equal(compatgateWarnings((await watcher.next()).warnings).length, 1);
    // split.ts was the only module that needed the entry of `Intl.Segmenter`.
    await watcher.edit(
      join(root, 'src/index.ts'),
      "import { last } from './match.ts';\nimport { clean } from './clean.ts';\nconsole.log(last('ab'), clean);\n",
    );
    const second = await watcher.next();
    assert.equal(second.error, undefined);
    assert.deepEqual(compatgateWarnings(second.warnings), [
      `compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${SEGMENTER}", allow[2] "${UNUSED}". Remove them unless other code needs them`,
    ]);
  });

  test('a rebuild after a build that compatgate failed has no report of unused entries', async t => {
    const segment = "export const split = (text: string) => [...new Intl.Segmenter('en').segment(text)];\n";
    const root = createProject({
      ...PROJECT,
      'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}"] }`,
      'src/split.ts': segment,
    });
    const watcher = watchRollup(root);
    t.after(() => watcher.close());
    const first = await watcher.next();
    assert.equal(first.error, undefined);
    assert.deepEqual(compatgateWarnings(first.warnings), []);
    // `Object.groupBy` fails the build, and Rollup keeps the cache of the build before it.
    await watcher.edit(
      join(root, 'src/split.ts'),
      'export const split = (text: string) => Object.groupBy([text], x => x);\n',
    );
    assert.match((await watcher.next()).error ?? '', /compatgate found 1 error/);
    // Rollup takes the first code of split.ts from that cache: the record of the failed build is not of it.
    await watcher.edit(join(root, 'src/split.ts'), segment);
    const third = await watcher.next();
    assert.equal(third.error, undefined);
    assert.deepEqual(compatgateWarnings(third.warnings), []);
  });

  test('a rebuild after a build that another plugin failed at its end has no report of unused entries', async t => {
    const segment = "export const split = (text: string) => [...new Intl.Segmenter('en').segment(text)];\n";
    const root = createProject({
      ...PROJECT,
      'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}"] }`,
      'src/split.ts': segment,
    });
    // Rollup calls the `buildEnd` hooks in parallel: compatgate does not see the error of this one.
    let builds = 0;
    const failing = {
      name: 'fails-the-second-build',
      buildEnd() {
        builds += 1;
        if (builds === 2) {
          throw new Error('the second build fails');
        }
      },
    };
    const watcher = watchRollup(root, undefined, [failing]);
    t.after(() => watcher.close());
    const first = await watcher.next();
    assert.equal(first.error, undefined);
    assert.deepEqual(compatgateWarnings(first.warnings), []);
    // split.ts no longer needs the entry of `Intl.Segmenter`, and the build fails; Rollup keeps the cache before it.
    await watcher.edit(join(root, 'src/split.ts'), 'export const split = (text: string) => text.split(" ");\n');
    assert.match((await watcher.next()).error ?? '', /the second build fails/);
    // Rollup takes the first code of split.ts from that cache: the record of the failed build is not of it.
    await watcher.edit(join(root, 'src/split.ts'), segment);
    const third = await watcher.next();
    assert.equal(third.error, undefined);
    assert.deepEqual(compatgateWarnings(third.warnings), []);
  });

  test('a rebuild gives one summary of the places of every module', async t => {
    const root = createProject(PARTIAL_PROJECT);
    const watcher = watchRollup(root, PARTIAL_OPTIONS);
    t.after(() => watcher.close());
    const first = await watcher.next();
    assert.equal(first.error, undefined);
    assert.match(findingsOf(first.warnings).join('\n'), SUMMARY);
    await watcher.edit(join(root, 'src/b.ts'), `${PARTIAL_PROJECT['src/b.ts']}\n`);
    // Rollup takes `a.ts` from its cache: the places of its record join the summary.
    const found = findingsOf((await watcher.next()).warnings);
    assert.equal(found.length, 1, found.join('\n'));
    assert.match(found[0] ?? '', SUMMARY);
  });
});

describe('esbuild loader', () => {
  test('a script keeps the loader of the esbuild options', async () => {
    const root = createProject({
      'src/index.ts': "import { view } from './view.js';\nconsole.log(view);\n",
      'src/view.js': 'const h = (...args) => args;\nexport const view = <div>{new Intl.Segmenter()}</div>;\n',
    });
    const error = await esbuild
      .build({
        absWorkingDir: root,
        entryPoints: [join(root, 'src/index.ts')],
        bundle: true,
        write: false,
        logLevel: 'silent',
        jsxFactory: 'h',
        loader: { '.js': 'jsx' },
        plugins: [compatgateEsbuild({ targets: 'Firefox >= 115' })],
      })
      .then(
        () => undefined,
        (failure: Error) => failure.message,
      );
    // The JSX parses, and the check of compatgate runs on the file.
    assert.match(error ?? '', /\[compatgate\/exact\] src\/view\.js:2:31: javascript\.builtins\.Intl\.Segmenter/);
  });
});
