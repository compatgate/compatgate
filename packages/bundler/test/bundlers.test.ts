import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { createProject, editFile } from '@compatgate/test-utils';

import { clearProcessMessages } from '../src/plugin.ts';
import {
  COMPATGATE,
  TARGETS,
  backdateFiles,
  compatgateMessages,
  rspackBundler,
  webpackBundler,
  type Bundler,
} from './helpers.ts';

// Three modules: a class static block that SWC lowers for Safari 15.6, next to a lookbehind assertion that no
// transpiler lowers; `Intl.Segmenter` (Firefox 115 lacks it); a lookbehind assertion again.
const PROJECT = {
  '.browserslistrc': TARGETS,
  'src/index.ts': [
    "import { Counter, word } from './counter.ts';",
    "import { split } from './split.ts';",
    "import { last } from './match.ts';",
    'console.log(new Counter(), word, split("a b"), last("ab"));',
  ].join('\n'),
  'src/counter.ts': [
    'export class Counter {',
    '  static count: number;',
    '  static {',
    '    Counter.count = 0;',
    '  }',
    '}',
    'export const word = /(?<=a)b/;',
    '',
  ].join('\n'),
  'src/split.ts': "export const split = (text: string) =>\n  [...new Intl.Segmenter('en').segment(text)];\n",
  'src/match.ts': 'export const last = (text: string) => /(?<=a)b/.exec(text);\n',
};

const SEGMENTER = 'javascript.builtins.Intl.Segmenter';
const LOOKBEHIND = 'javascript.regular_expressions.lookbehind_assertion';
const STATIC_BLOCK = 'javascript.classes.static.initialization_blocks';
// Every target supports it.
const NATIVE = 'api.fetch';
// Firefox 115 lacks them, and no module uses them.
const UNUSED = ['api.Highlight', 'api.CloseWatcher', 'javascript.builtins.Iterator.concat'];

// TypeScript lines before the finding: the transpiled module has `Intl.Segmenter` on another line than line 6.
const SPLIT_SOURCE = [
  'interface Options {',
  '  locale: string;',
  '}',
  '',
  "export const split = (text: string, options: Options = { locale: 'en' }) =>",
  '  [...new Intl.Segmenter(options.locale).segment(text)];',
  '',
].join('\n');

// Seven places of a feature that Chrome 97 supports only in part, in two modules.
const PARTIAL = 'api.BarcodeDetector.BarcodeDetector';
const PARTIAL_PATTERN = PARTIAL.replaceAll('.', '\\.');
const PARTIAL_PROJECT = {
  'src/index.ts': "import './a.ts';\nimport './b.ts';\n",
  'src/a.ts': 'new BarcodeDetector();\n'.repeat(4),
  'src/b.ts': 'new BarcodeDetector();\n'.repeat(3),
};
const PARTIAL_OPTIONS = { targets: 'Chrome >= 97' };

/**
 * The text from the marker of compatgate on, without the frame that the bundler adds. rspack colors its messages when
 * the terminal or CI supports colors: the codes go.
 */
function texts(messages: readonly string[]): string[] {
  return compatgateMessages(messages).map(message =>
    stripVTControlCharacters(message.slice(message.search(COMPATGATE))).trimEnd(),
  );
}

for (const bundler of [rspackBundler, webpackBundler] satisfies Bundler[]) {
  describe(bundler.name, () => {
    test('a finding of every module is an error of the build; a lowered syntax is no finding', async () => {
      const { errors, warnings } = await bundler.build(createProject(PROJECT));
      const messages = texts(errors);
      assert.equal(messages.length, 3, errors.join('\n---\n'));
      const segmenter = messages.find(message => message.includes(SEGMENTER));
      assert.match(
        segmenter ?? '',
        /^\[compatgate\/exact\] src\/split\.ts:\d+:\d+ \(position in the transpiled module\): /,
      );
      assert.match(segmenter ?? '', /Intl\.Segmenter is not supported in Firefox 115/);
      assert.match(
        messages.find(message => message.includes('src/match.ts')) ?? '',
        /^\[compatgate\/exact\] src\/match\.ts:1:\d+ \(position in the transpiled module\): .*lookbehind_assertion/,
      );
      // The module of the lowered static block is checked: its lookbehind assertion is a finding.
      assert.match(messages.find(message => message.includes('src/counter.ts')) ?? '', /lookbehind_assertion/);
      assert.ok(![...errors, ...warnings].some(message => message.includes(STATIC_BLOCK)));
      assert.deepEqual(compatgateMessages(warnings), []);
    });

    test('a severity of `warn` makes the findings warnings, and the build succeeds', async () => {
      const { errors, warnings } = await bundler.build(createProject(PROJECT), { severity: { exact: 'warn' } });
      assert.deepEqual(errors, []);
      assert.equal(compatgateMessages(warnings).length, 3, warnings.join('\n---\n'));
    });

    test('a severity of `off` drops the findings', async () => {
      const { errors, warnings } = await bundler.build(createProject(PROJECT), { severity: { exact: 'off' } });
      assert.deepEqual(errors, []);
      assert.deepEqual(compatgateMessages(warnings), []);
    });

    test('heuristic and partial findings are warnings by default', async () => {
      const root = createProject({
        'src/index.ts': 'export const sorted = (items: number[]) => items.toSorted();\nnew BarcodeDetector();\n',
      });
      const { errors, warnings } = await bundler.build(root, { targets: 'Chrome >= 97' });
      assert.deepEqual(compatgateMessages(errors), []);
      const messages = texts(warnings);
      assert.equal(messages.length, 2, warnings.join('\n---\n'));
      // The label names the confidence. One place of a partial feature is a finding, not a summary.
      assert.ok(
        messages.some(message => /^\[compatgate\/heuristic\] src\/index\.ts:1:.*Array\.toSorted/.test(message)),
      );
      assert.ok(
        messages.some(message => /^\[compatgate\/partial\] src\/index\.ts:2:.*api\.BarcodeDetector/.test(message)),
      );
    });

    test('with the source maps of the loaders a finding points at the line of the source', async () => {
      const root = createProject({ ...PROJECT, 'src/split.ts': SPLIT_SOURCE });
      const messages = texts((await bundler.build(root, {}, { devtool: 'source-map' })).errors);
      assert.equal(messages.length, 3, messages.join('\n'));
      assert.ok(
        messages.some(message =>
          message.startsWith(`[compatgate/exact] src/split.ts:6:11: ${SEGMENTER} is not supported in Firefox 115`),
        ),
        messages.join('\n'),
      );
      assert.ok(!messages.some(message => message.includes('transpiled')), messages.join('\n'));
    });

    test('seven places of one partial feature are one warning at the end of the build', async () => {
      const root = createProject(PARTIAL_PROJECT);
      const { errors, warnings } = await bundler.build(root, PARTIAL_OPTIONS, { devtool: 'source-map' });
      assert.deepEqual(compatgateMessages(errors), []);
      const messages = texts(warnings);
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(
        messages[0] ?? '',
        new RegExp(
          `^\\[compatgate/partial\\] ${PARTIAL_PATTERN} in 7 places, the first 5: src/a\\.ts:1:\\d+, src/a\\.ts:2:\\d+, ` +
            `src/a\\.ts:3:\\d+, src/a\\.ts:4:\\d+, src/b\\.ts:1:\\d+\\. ${PARTIAL_PATTERN} is only partially supported in Chrome 97`,
        ),
      );
      // A warning of the build, not of a module.
      assert.doesNotMatch(compatgateMessages(warnings)[0] ?? '', /Module Warning|unplugin/);
    });

    test('a child compilation keeps its partial findings one by one, out of the summary', async () => {
      const root = createProject({ ...PARTIAL_PROJECT, 'src/child.ts': 'new BarcodeDetector();\n'.repeat(2) });
      const { warnings, childWarnings } = await bundler.build(root, PARTIAL_OPTIONS, { child: './src/child.ts' });
      const messages = texts(warnings);
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(messages[0] ?? '', new RegExp(`^\\[compatgate/partial\\] ${PARTIAL_PATTERN} in 7 places, `));
      const child = texts(childWarnings);
      assert.equal(child.length, 2, child.join('\n'));
      assert.ok(
        child.every(message => /^\[compatgate\/partial\] src\/child\.ts:\d+:\d+ /.test(message)),
        child.join('\n'),
      );
    });

    test('partial findings of the level `error` are errors one by one', async () => {
      const root = createProject(PARTIAL_PROJECT);
      const { errors, warnings } = await bundler.build(root, { ...PARTIAL_OPTIONS, severity: { partial: 'error' } });
      assert.deepEqual(compatgateMessages(warnings), []);
      assert.equal(texts(errors).length, 7, errors.join('\n'));
    });

    test('a build with modules from the persistent cache gives the partial findings one by one', async () => {
      const root = createProject(PARTIAL_PROJECT);
      backdateFiles(root);
      const first = await bundler.build(root, PARTIAL_OPTIONS, { cache: 'filesystem' });
      assert.equal(texts(first.warnings).length, 1, first.warnings.join('\n'));
      // The next compiler builds the edited module and takes the others from the cache.
      editFile(join(root, 'src/b.ts'), `${PARTIAL_PROJECT['src/b.ts']}\n`);
      const messages = texts((await bundler.build(root, PARTIAL_OPTIONS, { cache: 'filesystem' })).warnings);
      // The persistent cache of rspack does not give the warnings of a module again, from any loader.
      assert.equal(messages.length, bundler.name === 'rspack' ? 3 : 7, messages.join('\n'));
      assert.ok(
        messages.every(message => /^\[compatgate\/partial\] src\/[ab]\.ts:\d+:\d+ /.test(message)),
        messages.join('\n'),
      );
    });

    test('a watch rebuild gives one summary of the places of every module', async t => {
      const root = createProject(PARTIAL_PROJECT);
      backdateFiles(root);
      const compiler = bundler.compiler(root, PARTIAL_OPTIONS, { cache: true });
      t.after(() => compiler.close());
      const summary = new RegExp(`^\\[compatgate/partial\\] ${PARTIAL_PATTERN} in 7 places, the first 5: `);
      const first = texts((await compiler.run()).warnings);
      assert.equal(first.length, 1, first.join('\n'));
      assert.match(first[0] ?? '', summary);
      // webpack takes a.ts from its memory cache: the places of its record join the summary.
      editFile(join(root, 'src/b.ts'), `${PARTIAL_PROJECT['src/b.ts']}\n`);
      const second = texts((await compiler.run()).warnings);
      assert.equal(second.length, 1, second.join('\n'));
      assert.match(second[0] ?? '', summary);
    });

    test('the `targets` option replaces the browserslist config', async () => {
      const all = await bundler.build(createProject(PROJECT), { targets: 'Chrome >= 130' });
      assert.deepEqual(compatgateMessages(all.errors), []);
      // The config allows everything, and the option gives targets without `Intl.Segmenter`.
      const root = createProject({ ...PROJECT, '.browserslistrc': 'Chrome >= 130' });
      assert.deepEqual(compatgateMessages((await bundler.build(root)).errors), []);
      assert.equal(compatgateMessages((await bundler.build(root, { targets: TARGETS })).errors).length, 3);
    });

    test('a module that compatgate cannot parse is one warning, and the build goes on', async () => {
      const root = createProject({
        ...PROJECT,
        'src/index.ts': "import text from 'flow-lib';\nimport css from './a.css';\nconsole.log(text, css);\n",
        'src/a.css': 'a { color: red }\n',
        'node_modules/flow-lib/package.json': '{ "name": "flow-lib", "main": "index.js" }',
        'node_modules/flow-lib/index.js': '// @flow\nexport function f(x: ?number): string {\n  return String(x);\n}\n',
      });
      const { errors, warnings } = await bundler.build(root);
      assert.deepEqual(errors, []);
      assert.deepEqual(texts(warnings), [
        '[compatgate] cannot check node_modules/flow-lib/index.js: Flow is not supported',
      ]);
    });

    test('a style module gets no loader of the plugin', async () => {
      const root = createProject({
        ...PROJECT,
        'src/index.ts': "import css from './a.css';\nconsole.log(css);\n",
        'src/a.css': 'a { color: red }\n',
      });
      const { loaders } = await bundler.build(root);
      // rspack gives no loaders of its modules to JavaScript.
      if (bundler.name === 'webpack') {
        assert.deepEqual(loaders.get(join(root, 'src/a.css')), []);
        assert.ok(loaders.get(join(root, 'src/index.ts'))?.some(loader => loader.includes('unplugin')));
      }
    });

    test('allow entries of the options and of compatgate.jsonc suppress the findings', async () => {
      const fromOptions = await bundler.build(createProject(PROJECT), { allow: [SEGMENTER, LOOKBEHIND] });
      assert.deepEqual(compatgateMessages(fromOptions.errors), []);

      const root = createProject({
        ...PROJECT,
        'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", { "feature": "${LOOKBEHIND}", "files": "src/match.ts" }] }`,
      });
      const fromConfig = texts((await bundler.build(root)).errors);
      assert.equal(fromConfig.length, 1, fromConfig.join('\n'));
      assert.match(fromConfig[0] ?? '', /src\/counter\.ts.*lookbehind_assertion/);
    });

    test('the `extends` option adds a base list before the entries of the project', async () => {
      const root = createProject({
        ...PROJECT,
        'base.jsonc': `{ "allow": ["${SEGMENTER}"] }`,
        'compatgate.jsonc': `{ "allow": ["${LOOKBEHIND}"] }`,
      });
      const { errors } = await bundler.build(root, { extends: ['./base.jsonc'] });
      assert.deepEqual(compatgateMessages(errors), []);
    });

    test('an allow entry with `packages` applies to the modules of that package only', async () => {
      const root = createProject({
        '.browserslistrc': TARGETS,
        'compatgate.jsonc': `{ "allow": [{ "feature": "${SEGMENTER}", "packages": ["seg-lib"] }] }`,
        'src/index.ts': "import { words } from 'seg-lib';\nconsole.log(words, new Intl.Segmenter('en'));\n",
        'node_modules/seg-lib/package.json': '{ "name": "seg-lib", "main": "index.js" }',
        'node_modules/seg-lib/index.js': "export const words = new Intl.Segmenter('en');\n",
      });
      const messages = compatgateMessages((await bundler.build(root)).errors);
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(messages[0] ?? '', /src\/index\.ts:2:/);
    });

    test('a module of a dependency takes the configs of the project, not the ones the dependency ships', async () => {
      const root = createProject({
        '.browserslistrc': 'Chrome >= 97',
        'compatgate.jsonc': '{ "allow": [{ "feature": "api.structuredClone", "packages": ["lib"] }] }',
        'src/index.ts': "import { copy, groups } from 'lib';\nconsole.log(copy, groups);\n",
        'node_modules/lib/package.json': JSON.stringify({
          name: 'lib',
          main: 'index.js',
          browserslist: 'Chrome >= 120',
        }),
        'node_modules/lib/compatgate.jsonc': '{ "allow": [] }',
        'node_modules/lib/index.js':
          'export const copy = structuredClone({});\nexport const groups = Object.groupBy([], String);\n',
      });
      const { errors, fileDependencies, missingDependencies } = await bundler.build(root);
      // Chrome 97 lacks both features, and the entry of the project allows one of them in `lib`.
      const messages = texts(errors);
      assert.equal(messages.length, 1, errors.join('\n---\n'));
      assert.match(messages[0] ?? '', /node_modules\/lib\/index\.js:2:.*Object\.groupBy/);
      const configs = [...fileDependencies, ...missingDependencies].filter(
        path =>
          path.includes('node_modules') &&
          ['compatgate.jsonc', '.browserslistrc', 'browserslist'].includes(basename(path)),
      );
      assert.deepEqual(configs, []);
      assert.ok(fileDependencies.has(join(root, '.browserslistrc')), [...fileDependencies].join('\n'));
      assert.ok(fileDependencies.has(join(root, 'compatgate.jsonc')), [...fileDependencies].join('\n'));
    });

    test('a project that lies inside node_modules keeps its own configs', async () => {
      const root = createProject({
        '.browserslistrc': 'Chrome >= 130',
        'compatgate.jsonc': '{ "allow": ["javascript.builtins.Object.groupBy"] }',
        'node_modules/proj/.browserslistrc': 'Chrome >= 97',
        'node_modules/proj/compatgate.jsonc': '{ "allow": ["api.structuredClone"] }',
        'node_modules/proj/src/index.ts': 'console.log(structuredClone({}), Object.groupBy([], String));\n',
      });
      const project = join(root, 'node_modules/proj');
      const { errors, fileDependencies } = await bundler.build(project);
      // Chrome 97 lacks both features, and the config of the project allows one of them.
      const messages = texts(errors);
      assert.equal(messages.length, 1, errors.join('\n---\n'));
      assert.match(messages[0] ?? '', /src\/index\.ts:1:.*Object\.groupBy/);
      assert.ok(fileDependencies.has(join(project, 'compatgate.jsonc')), [...fileDependencies].join('\n'));
      assert.ok(fileDependencies.has(join(project, '.browserslistrc')), [...fileDependencies].join('\n'));
    });

    test('`include` and `exclude` match the path of the module', async () => {
      const excluded = await bundler.build(createProject(PROJECT), {
        exclude: ['src/split.ts', /(match|counter)\.ts$/],
      });
      assert.deepEqual(compatgateMessages(excluded.errors), []);
      const included = await bundler.build(createProject(PROJECT), { include: 'src/**/split.ts' });
      assert.equal(compatgateMessages(included.errors).length, 1);
    });

    test('glob characters in the project root are literal in `include`', async () => {
      const root = createProject(PROJECT, 'compatgate (1) [x]-');
      const messages = texts((await bundler.build(root, { include: 'src/**/split.ts' })).errors);
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(messages[0] ?? '', /^\[compatgate\/exact\] src\/split\.ts:/);
    });

    test('a `#` in the project path is no hash of the module id', async () => {
      const root = createProject(PROJECT, 'compatgate-C#-');
      const messages = texts((await bundler.build(root)).errors);
      assert.equal(messages.length, 3, messages.join('\n'));
      assert.ok(
        messages.some(message => message.startsWith('[compatgate/exact] src/split.ts:')),
        messages.join('\n'),
      );
    });

    test('a config error is one error of the build with the text of the core', async () => {
      const root = createProject({ ...PROJECT, 'compatgate.jsonc': '{ "allow": [{ "feature": 1 }] }' });
      const { errors } = await bundler.build(root);
      const messages = compatgateMessages(errors);
      assert.equal(messages.length, 1, errors.join('\n---\n'));
      assert.match(messages[0] ?? '', /compatgate\.jsonc: allow\[0\]: expected a feature id/);
    });

    test('a wrong query of the targets is one error of the build', async () => {
      const { errors } = await bundler.build(createProject(PROJECT), { targets: 'Chrome >= nonsense' });
      const messages = compatgateMessages(errors);
      assert.equal(messages.length, 1, errors.join('\n---\n'));
      assert.match(messages[0] ?? '', /Chrome >= nonsense/);
    });

    test('two browserslist configs in one directory are one error of the build', async () => {
      // In a subdirectory: webpack reads the browserslist config of the root itself.
      const root = createProject({
        ...PROJECT,
        'src/index.ts': "import { a } from './lib/a.ts';\nimport { b } from './lib/b.ts';\nconsole.log(a, b);\n",
        'src/lib/.browserslistrc': 'Chrome >= 97',
        'src/lib/package.json': JSON.stringify({ browserslist: ['Chrome >= 97'] }),
        'src/lib/a.ts': 'export const a = 1;\n',
        'src/lib/b.ts': 'export const b = 2;\n',
      });
      const messages = texts((await bundler.build(root)).errors);
      assert.equal(messages.length, 1, messages.join('\n---\n'));
      assert.match(messages[0] ?? '', /contains both \.browserslistrc and package\.json with browsers/);
    });

    test('the build depends on the configs of its modules and on the places of a new config in the root', async () => {
      const root = createProject(PROJECT);
      const { fileDependencies, missingDependencies } = await bundler.build(root);
      assert.ok(fileDependencies.has(join(root, '.browserslistrc')), [...fileDependencies].join('\n'));
      for (const name of ['compatgate.jsonc', 'browserslist', 'package.json']) {
        assert.ok(missingDependencies.has(join(root, name)), [...missingDependencies].join('\n'));
      }
      // A new config below the root applies after a restart.
      assert.ok(!missingDependencies.has(join(root, 'src/compatgate.jsonc')), [...missingDependencies].join('\n'));
      assert.ok(!missingDependencies.has(join(root, 'src/.browserslistrc')), [...missingDependencies].join('\n'));
    });

    test('a new compatgate.jsonc in the project root shows in the next build', async t => {
      const root = createProject(PROJECT);
      const compiler = bundler.compiler(root, {}, { cache: true });
      t.after(() => compiler.close());
      assert.equal(texts((await compiler.run()).errors).length, 3);
      editFile(join(root, 'compatgate.jsonc'), `{ "allow": ["${LOOKBEHIND}", "${SEGMENTER}"] }`);
      assert.deepEqual(texts((await compiler.run()).errors), []);
    });

    test('a new browserslist config in the project root shows in the next build', async t => {
      const { '.browserslistrc': _, ...rest } = PROJECT;
      const root = createProject({ ...rest, 'package.json': '{}' });
      const compiler = bundler.compiler(root, { defaultTargets: TARGETS }, { cache: true });
      t.after(() => compiler.close());
      assert.equal(texts((await compiler.run()).errors).length, 3);
      editFile(join(root, '.browserslistrc'), 'Chrome >= 130');
      assert.deepEqual(texts((await compiler.run()).errors), []);
      rmSync(join(root, '.browserslistrc'));
      assert.equal(texts((await compiler.run()).errors).length, 3);
      // A package.json with the browserslist field is a config too.
      editFile(join(root, 'package.json'), JSON.stringify({ browserslist: ['Chrome >= 130'] }));
      assert.deepEqual(texts((await compiler.run()).errors), []);
    });

    test('a fix of a broken file of `extends` shows in the next build', async t => {
      const root = createProject({
        ...PROJECT,
        'base.jsonc': '{ "allow": [',
        'compatgate.jsonc': '{ "extends": "./base.jsonc" }',
      });
      const compiler = bundler.compiler(root, {}, { cache: true });
      t.after(() => compiler.close());
      const first = await compiler.run();
      assert.match(texts(first.errors).join('\n'), /base\.jsonc/);
      // webpack builds a module with errors again anyway; the dependency is what a persistent cache needs.
      assert.ok(first.fileDependencies.has(join(root, 'base.jsonc')), [...first.fileDependencies].join('\n'));
      editFile(join(root, 'base.jsonc'), `{ "allow": ["${LOOKBEHIND}", "${SEGMENTER}"] }`);
      assert.deepEqual(texts((await compiler.run()).errors), []);
    });

    test('an invalid glob of compatgate.jsonc is one error of the build, and its fix shows in the next build', async t => {
      // The glob fails in the binding, which names no config: the build watches every config of the configuration.
      const root = createProject({
        ...PROJECT,
        'compatgate.jsonc': `{ "allow": [{ "feature": "${SEGMENTER}", "files": ["src/[a"] }] }`,
      });
      const compiler = bundler.compiler(root, {}, { cache: true });
      t.after(() => compiler.close());
      const first = await compiler.run();
      const messages = compatgateMessages(first.errors);
      assert.equal(messages.length, 1, first.errors.join('\n---\n'));
      assert.match(messages[0] ?? '', /src\/\[a/);
      assert.ok(first.fileDependencies.has(join(root, 'compatgate.jsonc')), [...first.fileDependencies].join('\n'));
      editFile(join(root, 'compatgate.jsonc'), `{ "allow": ["${LOOKBEHIND}", "${SEGMENTER}"] }`);
      assert.deepEqual(texts((await compiler.run()).errors), []);
    });

    test('a fix of conflicting browserslist configs shows in the next build', async t => {
      const root = createProject({
        ...PROJECT,
        'src/lib/.browserslistrc': TARGETS,
        'src/lib/package.json': JSON.stringify({ browserslist: [TARGETS] }),
        'src/lib/a.ts': 'export const a = new Intl.Segmenter("en");\n',
        'src/index.ts': "import { a } from './lib/a.ts';\nconsole.log(a);\n",
      });
      const compiler = bundler.compiler(root, {}, { cache: true });
      t.after(() => compiler.close());
      const first = await compiler.run();
      assert.match(texts(first.errors).join('\n'), /contains both/);
      for (const name of ['package.json', '.browserslistrc']) {
        assert.ok(first.fileDependencies.has(join(root, 'src/lib', name)), name);
      }
      // Only the project root is watched for a new config: the error of src/lib adds no missing file.
      assert.ok(first.missingDependencies.has(join(root, 'browserslist')));
      for (const place of ['src/lib/browserslist', 'src/browserslist', '../browserslist']) {
        assert.ok(!first.missingDependencies.has(join(root, place)), place);
      }
      editFile(join(root, 'src/lib/package.json'), '{}');
      const messages = texts((await compiler.run()).errors);
      assert.equal(messages.length, 1, messages.join('\n'));
      assert.match(messages[0] ?? '', /src\/lib\/a\.ts.*Intl\.Segmenter/);
    });

    test('an edit of compatgate.jsonc or of the browserslist config shows in the next build', async t => {
      const root = createProject({ ...PROJECT, 'compatgate.jsonc': `{ "allow": ["${LOOKBEHIND}"] }` });
      const compiler = bundler.compiler(root, {}, { cache: true });
      t.after(() => compiler.close());
      assert.equal(texts((await compiler.run()).errors).length, 1);

      editFile(join(root, 'compatgate.jsonc'), `{ "allow": ["${LOOKBEHIND}", "${SEGMENTER}"] }`);
      assert.deepEqual(texts((await compiler.run()).errors), []);

      editFile(join(root, 'compatgate.jsonc'), '{ "allow": [] }');
      assert.equal(texts((await compiler.run()).errors).length, 3);

      editFile(join(root, '.browserslistrc'), 'Chrome >= 130');
      assert.deepEqual(texts((await compiler.run()).errors), []);
    });

    describe('the report of allow entries', () => {
      beforeEach(() => clearProcessMessages());

      test('an own entry that every target supports is a warning; an entry of a base is not', async () => {
        const root = createProject({
          ...PROJECT,
          'base.jsonc': `{ "allow": ["${NATIVE}"] }`,
          'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "${NATIVE}"] }`,
        });
        const { errors, warnings } = await bundler.build(root);
        assert.deepEqual(texts(errors), []);
        assert.deepEqual(texts(warnings), [
          `[compatgate] compatgate.jsonc, allow[2]: every target browser supports "${NATIVE}". Remove the entry.`,
        ]);
        editFile(
          join(root, 'compatgate.jsonc'),
          `{ "extends": "./base.jsonc", "allow": ["${SEGMENTER}", "${LOOKBEHIND}"] }`,
        );
        const base = await bundler.build(root);
        assert.deepEqual(texts([...base.errors, ...base.warnings]), []);
      });

      test('an inline entry names the options', async () => {
        const { warnings } = await bundler.build(createProject(PROJECT), {
          allow: [SEGMENTER, LOOKBEHIND, NATIVE],
        });
        assert.deepEqual(texts(warnings), [
          `[compatgate] compatgate.allow[2]: every target browser supports "${NATIVE}". Remove the entry.`,
        ]);
      });

      test('an unknown feature id of an own entry is an error of the build', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "api.Fetch", "${LOOKBEHIND}"] }`,
        });
        assert.deepEqual(texts((await bundler.build(root)).errors), [
          '[compatgate] compatgate.jsonc, allow[1]: unknown feature "api.Fetch". A feature id is a path in ' +
            '@mdn/browser-compat-data, such as "api.structuredClone". Did you mean "api.fetch"?',
        ]);
      });

      test('own entries that suppressed nothing are one warning at the end; used and base entries are not', async () => {
        const root = createProject({
          ...PROJECT,
          'base.jsonc': `{ "allow": ["${UNUSED[0]}"] }`,
          'compatgate.jsonc': JSON.stringify({
            extends: './base.jsonc',
            allow: [UNUSED[1], SEGMENTER, LOOKBEHIND, UNUSED[2]],
          }),
        });
        const { errors, warnings } = await bundler.build(root);
        assert.deepEqual(texts(errors), []);
        assert.deepEqual(texts(warnings), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${UNUSED[1]}", allow[3] "${UNUSED[2]}". Remove them unless other code needs them`,
        ]);
      });

      test('each config has its own report', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, UNUSED[1], LOOKBEHIND] }),
          'src/lib/compatgate.jsonc': JSON.stringify({ allow: [UNUSED[2], SEGMENTER] }),
          'src/lib/a.ts': "export const a = new Intl.Segmenter('en');\n",
          'src/index.ts': `import { a } from './lib/a.ts';\n${PROJECT['src/index.ts']}\nconsole.log(a);\n`,
        });
        const { errors, warnings } = await bundler.build(root);
        assert.deepEqual(texts(errors), []);
        assert.deepEqual(texts(warnings).sort(), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${UNUSED[1]}". Remove them unless other code needs them`,
          `[compatgate] src/lib/compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${UNUSED[2]}". Remove them unless other code needs them`,
        ]);
      });

      test('the modules of a concatenated build count', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        const { warnings } = await bundler.build(root, {}, { mode: 'production' });
        assert.deepEqual(texts(warnings), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[2] "${UNUSED[1]}". Remove them unless other code needs them`,
        ]);
      });

      test('a build with modules from the persistent cache has no report of unused entries', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        backdateFiles(root);
        const first = await bundler.build(root, {}, { cache: 'filesystem' });
        assert.equal(texts(first.warnings).length, 1, first.warnings.join('\n'));
        // The next compiler builds the edited module and takes the others from the cache.
        editFile(join(root, 'src/match.ts'), 'export const last = (text: string) => /(?<=b)a/.exec(text);\n');
        const second = await bundler.build(root, {}, { cache: 'filesystem' });
        assert.deepEqual(texts([...second.errors, ...second.warnings]), []);
      });

      test('a watch rebuild after an edit of one module gives the report of unused entries', async t => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        backdateFiles(root);
        const compiler = bundler.compiler(root, {}, { cache: true });
        t.after(() => compiler.close());
        const report = [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[2] "${UNUSED[1]}". Remove them unless other code needs them`,
        ];
        assert.deepEqual(texts((await compiler.run()).warnings), report);
        // webpack takes the other modules from its memory cache: their records of the first build count.
        editFile(join(root, 'src/match.ts'), 'export const last = (text: string) => /(?<=b)a/.exec(text);\n');
        const second = await compiler.run();
        assert.deepEqual(texts(second.errors), []);
        assert.deepEqual(texts(second.warnings), report);
      });

      test('an edit of compatgate.jsonc checks its modules again, and the report follows it', async t => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
          'src/lib/compatgate.jsonc': JSON.stringify({ allow: [UNUSED[2], SEGMENTER] }),
          'src/lib/a.ts': "export const a = new Intl.Segmenter('en');\n",
          'src/index.ts': `import { a } from './lib/a.ts';\n${PROJECT['src/index.ts']}\nconsole.log(a);\n`,
        });
        backdateFiles(root);
        const compiler = bundler.compiler(root, {}, { cache: true });
        t.after(() => compiler.close());
        const lib = `[compatgate] src/lib/compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${UNUSED[2]}". Remove them unless other code needs them`;
        assert.deepEqual(texts((await compiler.run()).warnings).sort(), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[2] "${UNUSED[1]}". Remove them unless other code needs them`,
          lib,
        ]);
        // The modules of the root config are checked again; the module of src/lib comes from the cache.
        editFile(join(root, 'compatgate.jsonc'), JSON.stringify({ allow: [UNUSED[0], SEGMENTER, LOOKBEHIND] }));
        const second = await compiler.run();
        assert.deepEqual(texts(second.errors), []);
        assert.deepEqual(texts(second.warnings).sort(), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${UNUSED[0]}". Remove them unless other code needs them`,
          lib,
        ]);
      });

      test('a module that leaves the build leaves the report of unused entries', async t => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        backdateFiles(root);
        const compiler = bundler.compiler(root, {}, { cache: true });
        t.after(() => compiler.close());
        assert.equal(texts((await compiler.run()).warnings).length, 1);
        // split.ts was the only module that needed the entry of `Intl.Segmenter`.
        editFile(
          join(root, 'src/index.ts'),
          [
            "import { Counter, word } from './counter.ts';",
            "import { last } from './match.ts';",
            'console.log(new Counter(), word, last("ab"));',
          ].join('\n'),
        );
        rmSync(join(root, 'src/split.ts'));
        const second = await compiler.run();
        assert.deepEqual(texts(second.errors), []);
        assert.deepEqual(texts(second.warnings), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[0] "${SEGMENTER}", allow[2] "${UNUSED[1]}". Remove them unless other code needs them`,
        ]);
      });

      test('a watch rebuild where another loader fails on a checked module has no report', async t => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        backdateFiles(root);
        const compiler = bundler.compiler(root, {}, { cache: true });
        t.after(() => compiler.close());
        assert.equal(texts((await compiler.run()).warnings).length, 1);
        // The record of the first build is of the old code: the transform of compatgate never sees the new one.
        editFile(join(root, 'src/split.ts'), "export const split = new Intl.Segmenter('en');\nconst = ;\n");
        const second = await compiler.run();
        assert.ok(second.errors.length > 0, 'the build fails');
        assert.deepEqual(texts(second.warnings), []);
      });

      test('an entry that only a module of a child compilation needs is used', async () => {
        const root = createProject({
          '.browserslistrc': TARGETS,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, UNUSED[1]] }),
          'src/index.ts': 'export const a = 1;\n',
          'src/child.ts': "export const split = new Intl.Segmenter('en');\n",
        });
        const { errors, warnings } = await bundler.build(root, {}, { child: './src/child.ts' });
        assert.deepEqual(texts(errors), []);
        assert.deepEqual(texts(warnings), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${UNUSED[1]}". Remove them unless other code needs them`,
        ]);
      });

      test('two modules of one file have a record each', async () => {
        // A rule of the issuer gives `split.ts` of `other.ts` another loader: two modules with one resource.
        const root = createProject({
          '.browserslistrc': TARGETS,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, UNUSED[1]] }),
          'strip-loader.cjs': "module.exports = () => 'export const split = () => [];\\n';\n",
          'src/index.ts': "import './other.ts';\nimport { split } from './split.ts';\nconsole.log(split('a'));\n",
          'src/other.ts': "import { split } from './split.ts';\nconsole.log(split('b'));\n",
          'src/split.ts': "export const split = (text: string) => [...new Intl.Segmenter('en').segment(text)];\n",
        });
        const rules = [{ test: /split\.ts$/, issuer: /other\.ts$/, use: join(root, 'strip-loader.cjs') }];
        const { errors, warnings } = await bundler.build(root, {}, { rules });
        // The module of `index.ts` needs the entry of `Intl.Segmenter`; the module of `other.ts` does not.
        assert.deepEqual(texts([...errors, ...warnings]), [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[1] "${UNUSED[1]}". Remove them unless other code needs them`,
        ]);
      });

      test('a watch rebuild of the changed modules only gives the report; a failing loader stops it', async t => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND, UNUSED[1]] }),
        });
        backdateFiles(root);
        // In development mode rspack builds again only the changed modules in watch mode; webpack does with its
        // memory cache.
        const watcher = bundler.watch(root, {}, { mode: 'development', cache: true });
        t.after(() => watcher.close());
        const report = [
          `[compatgate] compatgate.jsonc: allow entries that suppressed no finding in the code of this build: allow[2] "${UNUSED[1]}". Remove them unless other code needs them`,
        ];
        assert.deepEqual(texts((await watcher.next()).warnings), report);
        await watcher.edit(join(root, 'src/match.ts'), 'export const last = (text: string) => /(?<=b)a/.exec(text);\n');
        const second = await watcher.next();
        assert.deepEqual(texts(second.errors), []);
        assert.deepEqual(texts(second.warnings), report);
        await watcher.edit(join(root, 'src/split.ts'), "export const split = new Intl.Segmenter('en');\nconst = ;\n");
        const third = await watcher.next();
        assert.ok(third.errors.length > 0, 'the build fails');
        assert.deepEqual(texts(third.warnings), []);
      });

      test('a module that fails in another loader stops the report of unused entries', async () => {
        const root = createProject({
          ...PROJECT,
          // The transpiler fails on the module, and the transform of compatgate never sees it.
          'src/split.ts': "export const split = new Intl.Segmenter('en');\nconst = ;\n",
          'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, LOOKBEHIND] }),
        });
        const { errors, warnings } = await bundler.build(root);
        assert.ok(errors.length > 0, 'the build fails');
        assert.deepEqual(texts(warnings), []);
      });

      test('an unknown feature id of a base entry is a warning that names its file', async () => {
        const root = createProject({
          ...PROJECT,
          'config/base.jsonc': '{ "allow": ["api.BaseTypo"] }',
          'compatgate.jsonc': JSON.stringify({ extends: './config/base.jsonc', allow: [SEGMENTER, LOOKBEHIND] }),
        });
        const { errors, warnings } = await bundler.build(root);
        assert.deepEqual(texts(errors), []);
        assert.deepEqual(texts(warnings), [
          '[compatgate] config/base.jsonc, allow[0]: unknown feature "api.BaseTypo". compatgate ignores the entry.',
        ]);
      });

      test('a warning about a config shows once per process, on the build, not on a module', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "${LOOKBEHIND}", "${NATIVE}"] }`,
        });
        const first = await bundler.build(root);
        assert.equal(texts(first.warnings).length, 1, first.warnings.join('\n'));
        // A module warning names the loader that gave it.
        assert.doesNotMatch(compatgateMessages(first.warnings)[0] ?? '', /Module Warning|unplugin/);
        assert.deepEqual(texts((await bundler.build(root)).warnings), []);
      });

      test('an unknown feature id of an own entry fails every build', async () => {
        const root = createProject({
          ...PROJECT,
          'compatgate.jsonc': `{ "allow": ["${SEGMENTER}", "api.Fetch", "${LOOKBEHIND}"] }`,
        });
        for (let run = 0; run < 2; run += 1) {
          assert.equal(texts((await bundler.build(root)).errors).length, 1, `run ${run}`);
        }
      });

      test('targets with browsers that compatgate has no data for are one warning', async () => {
        // BCD has no data for Opera Mini by definition: it gives no warning.
        const root = createProject({ ...PROJECT, '.browserslistrc': `${TARGETS}, op_mini all, ie 11` });
        const { warnings } = await bundler.build(root, { severity: { exact: 'off' } });
        assert.deepEqual(texts(warnings), [
          `[compatgate] targets "${TARGETS}, op_mini all, ie 11" name browsers that compatgate has no data for: ie. compatgate does not check them`,
        ]);
      });
    });
  });
}
