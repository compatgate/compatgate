import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OptionsError as CoreOptionsError } from '@compatgate/core';

import * as bundler from '../src/index.ts';
import {
  PluginState,
  checkModule,
  clearProcessMessages,
  sourceMapLocate,
  type Locate,
  type Lower,
  type ModuleContext,
  type Scope,
} from '../src/plugin.ts';
import { loaderHost } from '../src/hosts/loader.ts';
import { LoweringEngineError, viteLower } from '../src/lowering.ts';
import { copiedColumns } from '../src/source-map.ts';
import { TARGETS, createProject, editFile } from './helpers.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const SEGMENTER = 'javascript.builtins.Intl.Segmenter';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('the package exports the unplugin factory and a plugin for every bundler', () => {
  assert.equal(typeof bundler.compatgate.raw, 'function');
  for (const name of [
    'compatgateWebpack',
    'compatgateRspack',
    'compatgateVite',
    'compatgateRollup',
    'compatgateRolldown',
    'compatgateEsbuild',
  ] as const) {
    assert.equal(typeof bundler[name], 'function', name);
  }
});

test('the plugin runs after the other transforms and keeps the code', async () => {
  const plugin = bundler.compatgateRollup();
  assert.equal(plugin.name, 'compatgate');
  // Rollup has no `enforce`: the plugin runs in the place of its array. unplugin keeps the field.
  assert.equal((plugin as { enforce?: unknown }).enforce, 'post');
  const vite = bundler.compatgateVite();
  assert.equal(vite.enforce, 'post');

  const raw = bundler.compatgate.raw({ targets: 'Chrome >= 130' }, { framework: 'rollup', versions: {} });
  const transform = raw.transform as { handler: (this: unknown, code: string, id: string) => unknown };
  const context = { addWatchFile() {}, error: assert.fail, warn: assert.fail };
  const id = join(packageDir, 'test/fixture.ts');
  assert.equal(await transform.handler.call(context, 'export const a = 1;\n', id), null);
});

test('the transform filter passes scripts and components and stops styles and virtual modules', () => {
  const raw = bundler.compatgate.raw(undefined, { framework: 'rollup', versions: {} });
  const { filter } = raw.transform as { filter: { id: { include: RegExp; exclude: RegExp } } };
  const passes = (id: string) => filter.id.include.test(id) && !filter.id.exclude.test(id);
  for (const id of [
    '/p/a.ts',
    '/p/a.mjs?v=1',
    '/p/a.jsx#x',
    '/p/App.vue',
    '/p/App.vue?vue&type=script&lang.ts',
    '/docs/page.md?vue&type=script&lang.ts',
    '/docs/page.md?vue&type=script&lang=tsx',
  ]) {
    assert.ok(passes(id), id);
  }
  for (const id of ['/p/a.css', '/p/a.css?inline', '/p/data.json', '/p/logo.svg?url', '\0virtual:x.js']) {
    assert.ok(!passes(id), id);
  }
});

test('a wrong severity is an error that names the option', () => {
  assert.throws(
    () => bundler.compatgateRollup({ severity: { exact: 'warning' as never } }),
    (error: Error & { code?: string }) =>
      error.code === 'COMPATGATE_OPTIONS' &&
      /^compatgate\.severity\.exact: expected "error", "warn" or "off"$/.test(error.message),
  );
  assert.throws(
    () => bundler.compatgateRollup({ severity: { syntax: 'off' } as never }),
    /OptionsError: compatgate\.severity: unknown key "syntax"\. Known keys: exact, heuristic, partial$/,
  );
  assert.throws(
    () => bundler.compatgateRollup({ severity: 'warn' } as never),
    /OptionsError: compatgate\.severity: expected an object$/,
  );
});

test('an unknown option is an error that lists the known options', () => {
  assert.throws(
    () => bundler.compatgateRollup({ target: 'Chrome >= 97' } as never),
    (error: Error & { code?: string }) =>
      error.code === 'COMPATGATE_OPTIONS' &&
      /^compatgate: unknown option "target"\. Known options: targets, defaultTargets, allow, extends, include, exclude, severity$/.test(
        error.message,
      ),
  );
});

test('an option set to undefined takes its default, and no options are no error', () => {
  bundler.compatgateRollup({ targets: undefined, severity: { exact: undefined, heuristic: 'off' } });
  bundler.compatgateRollup(undefined);
  bundler.compatgateRollup(null as never);
});

test('a filter of a wrong type is an error that names the option', () => {
  assert.throws(
    () => bundler.compatgateRollup({ include: 1 } as never),
    /OptionsError: compatgate\.include: expected a glob, a regular expression or an array of them$/,
  );
  assert.throws(
    () => bundler.compatgateRollup({ exclude: ['src/**', 2] } as never),
    /OptionsError: compatgate\.exclude: expected a glob, a regular expression or an array of them$/,
  );
});

test('every option of a wrong type is an error when the plugin is made', () => {
  const cases: Array<[options: Record<string, unknown>, message: RegExp]> = [
    [{ extends: '@co/allow' }, /^compatgate\.extends: expected an array of strings$/],
    [{ extends: ['@co/allow', 1] }, /^compatgate\.extends: expected an array of strings$/],
    [{ allow: 'api.x' }, /^compatgate\.allow: expected an array of feature ids and entries$/],
    [{ allow: ['api.x', 1] }, /^compatgate\.allow\[1\]: expected a feature id or an object$/],
    [{ allow: [null] }, /^compatgate\.allow\[0\]: expected a feature id or an object$/],
    [{ targets: ['Chrome >= 97'] }, /^compatgate\.targets: expected a string$/],
    [{ defaultTargets: 97 }, /^compatgate\.defaultTargets: expected a string$/],
  ];
  for (const [options, message] of cases) {
    assert.throws(
      () => bundler.compatgateRollup(options as never),
      (error: Error & { code?: string }) =>
        error instanceof CoreOptionsError && error.code === 'COMPATGATE_OPTIONS' && message.test(error.message),
      JSON.stringify(options),
    );
  }
});

test('the package gives the options error of the core', () => {
  assert.equal(bundler.OptionsError, CoreOptionsError);
});

test('an allow entry of the options may not set origin: compatgate sets it', t => {
  const root = createProject(t, {});
  const errors: string[] = [];
  const context: ModuleContext = {
    error: message => errors.push(message),
    warn: assert.fail,
    addWatchFile() {},
    addMissingFile() {},
  };
  const state = new PluginState(
    { targets: TARGETS, allow: [{ feature: 'api.structuredClone', origin: 'inherited' } as never] },
    root,
  );
  assert.equal(state.configuration(join(root, 'src/a.ts'), context), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /^\[compatgate\] compatgate\.allow\[0\]: unknown key "origin"/);
});

test('an edit of a config in the dev server drops the checkers of its old versions', t => {
  const root = createProject(t, { 'compatgate.jsonc': '{ "allow": [] }' });
  const config = join(root, 'compatgate.jsonc');
  const module = join(root, 'src/a.ts');
  // Every target supports the features: each version of the config warns once in the process.
  const warnings: string[] = [];
  const context: ModuleContext = {
    error: assert.fail,
    warn: message => warnings.push(message),
    addWatchFile() {},
    addMissingFile() {},
  };
  const features = ['api.fetch', 'api.Blob', 'api.URL', 'api.Request', 'api.Response'];
  clearProcessMessages();
  for (const serve of [false, true]) {
    const state = new PluginState({ targets: TARGETS }, root, () => serve);
    for (const feature of features) {
      editFile(config, `{ "allow": ["${feature}"] }`);
      // A build sees the configs as they were at its start: a watch build starts after each edit.
      if (!serve) {
        state.startBuild();
      }
      const configuration = state.configuration(module, context);
      // The module takes the edit at once, as the dev server checks it again right after the edit.
      assert.deepEqual(
        configuration?.entries.map(entry => entry.feature),
        [feature],
        `serve: ${serve}`,
      );
      state.fileChanged(config);
    }
    // A build drops the configurations that the build before it did not use; the dev server has no start of a
    // build, and an edit drops them.
    assert.equal(state.registry.size, serve ? 1 : 2, `serve: ${serve}`);
  }
  assert.deepEqual(
    warnings,
    features.map(
      feature =>
        `[compatgate] compatgate.jsonc, allow[0]: every target browser supports "${feature}". Remove the entry.`,
    ),
  );
});

test('once shows a message on each module, once per build or once per process', () => {
  clearProcessMessages();
  const state = new PluginState({}, '/p');
  const shown: string[] = [];
  const show = (scope: Scope, key: string) => state.once(scope, key, () => shown.push(`${scope} ${key}`));
  for (let run = 0; run < 2; run += 1) {
    show('module', 'a');
    show('build', 'b');
    show('process', 'c');
  }
  assert.deepEqual(shown, ['module a', 'build b', 'process c', 'module a']);
  state.startBuild();
  show('build', 'b');
  show('process', 'c');
  // Another plugin of the process has builds of its own.
  const other = new PluginState({}, '/q');
  other.once('build', 'b', () => shown.push('other build b'));
  other.once('process', 'c', () => shown.push('other process c'));
  assert.deepEqual(shown.slice(4), ['build b', 'other build b']);
});

test('the advice of a finding names the place of the allow entries', async t => {
  const root = createProject(t, { 'src/lib/compatgate.jsonc': '{ "allow": [] }' });
  const advice = async (options: { allow?: string[] }, path: string) => {
    const state = new PluginState({ targets: 'Firefox >= 115', ...options }, root);
    const errors: string[] = [];
    const context: ModuleContext = {
      error: message => errors.push(message),
      warn: assert.fail,
      addWatchFile() {},
      addMissingFile() {},
    };
    await checkModule(state, "new Intl.Segmenter('en');\n", { path: join(root, path) }, context);
    assert.equal(errors.length, 1, errors.join('\n'));
    return errors[0]?.replace(/^.*, or /, '');
  };
  const entry = 'add "javascript.builtins.Intl.Segmenter" to';
  assert.equal(await advice({}, 'src/lib/a.ts'), `${entry} src/lib/compatgate.jsonc.`);
  assert.equal(await advice({}, 'src/a.ts'), `${entry} compatgate.jsonc.`);
  assert.equal(await advice({ allow: [] }, 'src/lib/a.ts'), `${entry} compatgate.allow.`);
});

test('the warning about browsers without data names the targets of the module', async t => {
  // Two queries of one list of browsers: the modules share a checker.
  const queries = ['Firefox >= 115, ie 11', 'ie 11, Firefox >= 115'];
  const root = createProject(t, { 'a/.browserslistrc': queries[0] ?? '', 'b/.browserslistrc': queries[1] ?? '' });
  const state = new PluginState({ allow: [] }, root);
  const warnings: string[] = [];
  const context: ModuleContext = {
    error: assert.fail,
    warn: message => warnings.push(message),
    addWatchFile() {},
    addMissingFile() {},
  };
  t.after(clearProcessMessages);
  for (const directory of ['a', 'b']) {
    await checkModule(state, 'export {};\n', { path: join(root, directory, 'x.ts') }, context);
  }
  assert.deepEqual(
    warnings,
    queries.map(
      query =>
        `[compatgate] targets "${query}" name browsers that compatgate has no data for: ie. compatgate does not check them`,
    ),
  );
});

describe('the report of unused entries', () => {
  const UNUSED = 'api.Highlight';
  type Hooks = {
    buildStart: (this: unknown) => void;
    transform: { handler: (this: unknown, code: string, id: string) => Promise<unknown> };
    buildEnd: (this: unknown, error?: unknown) => void;
    vite: { configResolved: (config: { root: string; command: string }) => void };
  };

  function setup(t: TestContext, framework: 'rollup' | 'vite' | 'esbuild') {
    const root = createProject(t, { 'src/a.ts': '', 'src/b.ts': '' });
    const ids = [join(root, 'src/a.ts'), join(root, 'src/b.ts'), join(root, 'src/c.css'), '\0virtual:x'];
    const hooks = bundler.compatgate.raw(
      { targets: TARGETS, allow: [UNUSED] },
      { framework, versions: {} },
    ) as unknown as Hooks;
    const warnings: string[] = [];
    const context = {
      addWatchFile() {},
      warn: (message: string) => warnings.push(message),
      error: assert.fail,
      getModuleIds: () => ids.values(),
    };
    return { root, ids, hooks, warnings, context };
  }

  test('needs every checked module of the build to go through the transform', async t => {
    const { ids, hooks, warnings, context } = setup(t, 'rollup');
    hooks.buildStart.call(context);
    await hooks.transform.handler.call(context, 'export {};', ids[0] as string);
    hooks.buildEnd.call(context);
    // b.ts came from a cache; the style and the virtual module are not checked.
    assert.deepEqual(warnings, []);
    hooks.buildStart.call(context);
    for (const id of ids.slice(0, 2)) {
      await hooks.transform.handler.call(context, 'export {};', id);
    }
    hooks.buildEnd.call(context);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? '',
      /^\[compatgate\] allow entries that suppressed no finding in the code of this build: compatgate\.allow\[0\] /,
    );
    // A failed build has not seen every module.
    hooks.buildStart.call(context);
    for (const id of ids.slice(0, 2)) {
      await hooks.transform.handler.call(context, 'export {};', id);
    }
    hooks.buildEnd.call(context, new Error('failed'));
    assert.equal(warnings.length, 1);
  });

  test('a module whose configs have an error leaves the build without a report', async t => {
    const root = createProject(t, {
      '.browserslistrc': TARGETS,
      'src/nested/.browserslistrc': 'not a query',
    });
    const ids = [join(root, 'src/a.ts'), join(root, 'src/nested/b.ts')];
    const hooks = bundler.compatgate.raw(
      { allow: ['api.structuredClone'] },
      { framework: 'rollup', versions: {} },
    ) as unknown as Hooks;
    const warnings: string[] = [];
    const context = {
      addWatchFile() {},
      warn: (message: string) => warnings.push(message),
      error: assert.fail,
      getModuleIds: () => ids.values(),
    };
    hooks.buildStart.call(context);
    await hooks.transform.handler.call(context, 'export {};', ids[0] as string);
    // The error leaves b.ts unchecked: it may need the entry.
    await hooks.transform.handler.call(context, 'structuredClone(1);', ids[1] as string);
    assert.throws(() => hooks.buildEnd.call(context), /src\/nested\/\.browserslistrc/);
    assert.deepEqual(warnings, []);
  });

  test('the dev server of Vite and esbuild get none', async t => {
    for (const framework of ['vite', 'esbuild'] as const) {
      const { root, ids, hooks, warnings, context } = setup(t, framework);
      if (framework === 'vite') {
        hooks.vite.configResolved({ root, command: 'serve' });
      }
      hooks.buildStart.call(context);
      for (const id of ids.slice(0, 2)) {
        await hooks.transform.handler.call(context, 'export {};', id);
      }
      hooks.buildEnd.call(context);
      assert.deepEqual(warnings, [], framework);
    }
  });
});

test('the dev server of Vite warns of each partial finding at once: it has no end of a build', async t => {
  const root = createProject(t, {});
  const hooks = bundler.compatgate.raw({ targets: 'Chrome >= 97' }, { framework: 'vite', versions: {} }) as unknown as {
    buildStart: (this: unknown) => void;
    transform: { handler: (this: unknown, code: string, id: string) => Promise<unknown> };
    vite: { configResolved: (config: { root: string; command: string }) => void };
  };
  const warnings: string[] = [];
  const context = { addWatchFile() {}, warn: (message: string) => warnings.push(message), error: assert.fail };
  hooks.vite.configResolved({ root, command: 'serve' });
  hooks.buildStart.call(context);
  await hooks.transform.handler.call(context, 'new BarcodeDetector();\n'.repeat(7), join(root, 'src/a.ts'));
  assert.equal(warnings.length, 7, warnings.join('\n'));
  assert.match(warnings[0] ?? '', /^\[compatgate\/partial\] src\/a\.ts:1:5 /);
});

test('an end of a build without `warn` throws rather than lose the held partial findings', async t => {
  const root = createProject(t, {});
  const id = join(root, 'src/a.ts');
  const hooks = bundler.compatgate.raw(
    { targets: 'Chrome >= 97' },
    { framework: 'rollup', versions: {} },
  ) as unknown as {
    buildStart: (this: unknown) => void;
    transform: { handler: (this: unknown, code: string, id: string) => Promise<unknown> };
    buildEnd: (this: unknown, error?: unknown) => void;
  };
  const context = { addWatchFile() {}, error: assert.fail, getModuleIds: () => [id].values() };
  hooks.buildStart.call(context);
  await hooks.transform.handler.call(context, 'new BarcodeDetector();\n'.repeat(2), id);
  assert.throws(() => hooks.buildEnd.call(context), /2 partial findings would be lost/);
  // Nothing held, nothing lost.
  hooks.buildStart.call(context);
  await hooks.transform.handler.call(context, 'export {};\n', id);
  hooks.buildEnd.call(context);
});

test('a failed build without `warn` at its end keeps its own error', async t => {
  const root = createProject(t, {});
  const id = join(root, 'src/a.ts');
  const hooks = bundler.compatgate.raw(
    { targets: 'Chrome >= 97' },
    { framework: 'rollup', versions: {} },
  ) as unknown as {
    buildStart: (this: unknown) => void;
    transform: { handler: (this: unknown, code: string, id: string) => Promise<unknown> };
    buildEnd: (this: unknown, error?: unknown) => void;
  };
  const context = { addWatchFile() {}, error: assert.fail, getModuleIds: () => [id].values() };
  hooks.buildStart.call(context);
  await hooks.transform.handler.call(context, 'new BarcodeDetector();\n'.repeat(2), id);
  // The held findings are lost, and the bundler reports the error of the build.
  hooks.buildEnd.call(context, new Error('failed'));
});

test('a loader host without `isChild` on the compiler takes the module for one of the main compilation', () => {
  const reports = loaderHost(() => '/p').reports;
  const context = { getNativeBuildContext: () => ({ framework: 'webpack', compiler: {} }) };
  assert.equal(reports?.partial(context as never), 'record');
  assert.equal(reports?.inGraph?.(context as never), true);
});

test('only the records of the graph give the entries to report; the others only mark entries as used', t => {
  const root = createProject(t, {});
  const state = new PluginState({ targets: TARGETS, allow: [SEGMENTER, 'api.Highlight'] }, root);
  const context: ModuleContext = { error: assert.fail, warn: assert.fail, addWatchFile() {}, addMissingFile() {} };
  const configuration = state.configuration(join(root, 'src/a.ts'), context);
  const unused = (index: number) =>
    `[compatgate] allow entries that suppressed no finding in the code of this build: compatgate.allow[${index}]`;
  const record = (used: number[]) => ({ configuration, used, partials: [] });
  assert.match(state.unusedEntries([record([])], [record([0])]).join('\n'), new RegExp(`^${escape(unused(1))} `));
  // A configuration of a record outside the graph alone gives nothing to report.
  assert.deepEqual(state.unusedEntries([], [record([])]), []);
});

test('the entries of a config that a build read in two versions are not reported: the indexes may differ', t => {
  const allow = (entries: string[]) => JSON.stringify({ allow: entries });
  const root = createProject(t, {
    'compatgate.jsonc': allow([SEGMENTER, 'api.Highlight', 'api.Navigator.share']),
  });
  const context: ModuleContext = { error: assert.fail, warn() {}, addWatchFile() {}, addMissingFile() {} };
  // Two compilers of one process, as the browser and the server build of one project.
  const browser = new PluginState({ targets: TARGETS }, root);
  const server = new PluginState({ targets: TARGETS }, root);
  const first = browser.configuration(join(root, 'src/a.ts'), context);
  assert.equal(first?.entries.length, 3);
  editFile(join(root, 'compatgate.jsonc'), allow([SEGMENTER, 'api.Highlight']));
  // The first module of the other compiler checks the configs, and the core reads them again.
  server.configuration(join(root, 'src/a.ts'), context);
  const second = browser.configuration(join(root, 'src/b.ts'), context);
  assert.equal(second?.entries.length, 2);
  const records = [first, second].map(configuration => ({ configuration, used: [], partials: [] }));
  // The removed entry allow[2] is no unused entry of the file: the build does not report.
  assert.deepEqual(browser.unusedEntries(records), []);
  // The records of one version report.
  assert.equal(browser.unusedEntries(records.slice(1)).length, 1);
});

test('a reset of the core that leaves a config as it was keeps its report', t => {
  const root = createProject(t, {
    '.browserslistrc': `${TARGETS}\n`,
    'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, 'api.Highlight'] }),
    'src/lib/.browserslistrc': `${TARGETS}\n`,
  });
  const context: ModuleContext = { error: assert.fail, warn() {}, addWatchFile() {}, addMissingFile() {} };
  const state = new PluginState({}, root);
  const first = state.configuration(join(root, 'src/a.ts'), context);
  // The module of src/lib watches its own browserslist config, not the one of the root: a watch build takes it from
  // the cache after an edit of the root config, with the configuration of the old reads.
  const lib = state.configuration(join(root, 'src/lib/a.ts'), context);
  editFile(join(root, '.browserslistrc'), `${TARGETS.replace('97', '98')}\n`);
  state.startBuild();
  const app = state.configuration(join(root, 'src/a.ts'), context);
  // The core has read the configs again.
  assert.notEqual(app?.entries, first?.entries);
  const records = [lib, app].map(configuration => ({ configuration, used: [], partials: [] }));
  assert.match(state.unusedEntries(records).join('\n'), /compatgate\.jsonc: .*allow\[0\].*allow\[1\]/);
});

test('an entry that a config takes through extends counts as used in the config that owns it', t => {
  const root = createProject(t, {
    'compatgate.jsonc': JSON.stringify({ allow: [SEGMENTER, 'api.Highlight', 'api.Navigator.share'] }),
    'src/lib/compatgate.jsonc': JSON.stringify({ extends: ['../../compatgate.jsonc'], allow: ['api.CookieStore'] }),
  });
  const context: ModuleContext = { error: assert.fail, warn() {}, addWatchFile() {}, addMissingFile() {} };
  const state = new PluginState({ targets: TARGETS }, root);
  const app = state.configuration(join(root, 'src/a.ts'), context);
  const lib = state.configuration(join(root, 'src/lib/a.ts'), context);
  // The module of src/lib needed the entry of the root config at its index 2 in the root config.
  const share = lib?.entries.findIndex(entry => entry.feature === 'api.Navigator.share') ?? -1;
  assert.equal(lib?.entries[share]?.origin, 'inherited');
  const report = state.unusedEntries([
    { configuration: app, used: [], partials: [] },
    { configuration: lib, used: [share], partials: [] },
  ]);
  assert.doesNotMatch(report.join('\n'), /api\.Navigator\.share/);
  assert.match(report.join('\n'), /^\[compatgate\] compatgate\.jsonc: .*allow\[0\]/m);
});

test('a source map gives the position in the source file, or nothing when it does not reach the file', t => {
  const root = createProject(t, { 'src/a.ts': 'const a = 1;\n' });
  const file = { path: join(root, 'src/out/a.js') };
  // One segment: column 0 of line 1 comes from column 0 of line 1 of the source.
  const map = (source: string, content?: string) => () => ({
    version: 3,
    sources: [source],
    names: [],
    mappings: 'AAAA',
    ...(content === undefined ? {} : { sourcesContent: [content] }),
  });
  const start = { line: 1, column: 0 };
  const expected = { path: join(root, 'src/a.ts'), line: 1, column: 0 };
  assert.deepEqual(sourceMapLocate(file, map('../a.ts'))(start), expected);
  assert.deepEqual(sourceMapLocate(file, map(`file://${join(root, 'src/a.ts')}`))(start), expected);
  assert.deepEqual(
    sourceMapLocate(file, map(`${join(root, 'src/a.ts')}?v=1`, '\uFEFFconst a = 1;\n'))(start),
    expected,
  );
  // The text of the source differs from the file: the map ends at the code of a plugin.
  // A loader of webpack may give the map as its JSON text.
  assert.deepEqual(sourceMapLocate(file, () => JSON.stringify(map('../a.ts')()))(start), expected);
  assert.equal(sourceMapLocate(file, map('../a.ts', 'export {};\n'))(start), null);
  assert.equal(sourceMapLocate(file, map('\0virtual:a'))(start), null);
  assert.equal(sourceMapLocate(file, map('webpack://app/a.ts'))(start), null);
  assert.equal(sourceMapLocate(file, () => ({ mappings: '' }))(start), null);
  assert.equal(sourceMapLocate(file, () => null)(start), null);
  assert.equal(
    sourceMapLocate(file, () => {
      throw new Error('broken map');
    })(start),
    null,
  );
});

test('a finding inside a segment of the map keeps its offset when the segment copies the text', t => {
  const sources = {
    'src/a.ts': 'let r: R = /(?<=a)b/;\n',
    'src/comment.ts': 'const x = a /* why */ ?? b;\n',
    'src/spaces.ts': 'const y = a  ?? b;\n',
    'src/types.ts': 'const z = a as T ?? b;\n',
  };
  const root = createProject(t, sources);
  const locate = (name: string, mappings: string) =>
    sourceMapLocate({ path: join(root, 'src/out', name) }, () => ({
      version: 3,
      sources: [`../${name.replace('.js', '.ts')}`],
      names: [],
      mappings,
    }));
  const at = (place: Locate, output: string, column: number, token: string) =>
    place({ line: 1, column }, { code: output, range: [column, column + token.length] });
  const position = (name: string, column: number) => ({ path: join(root, 'src', name), line: 1, column });
  // The types are gone: column 4 of the output comes from column 4 of the source, column 8 from column 11.
  const types = locate('a.js', 'AAAA,IAAI,IAAO');
  const output = 'let r = /(?<=a)b/;';
  // `(?<=` lies one column into the literal, in the source too.
  assert.deepEqual(at(types, output, 9, '(?<='), position('a.ts', 12));
  // The output has `r ` where the source has `r:`: the place is the start of the segment.
  assert.deepEqual(at(types, output, 6, '='), position('a.ts', 4));
  // Without the text of the checked code the place is the start of the segment.
  assert.deepEqual(types({ line: 1, column: 9 }), position('a.ts', 11));
  // The transform dropped text after the copied prefix `a `: the source has no `??` at the offset, so the place
  // is the start of the segment, not a column inside the comment, the second space or `as T`.
  const operator = 'const x = a ?? b;';
  assert.deepEqual(at(locate('comment.js', 'AAAA,UAAU,KAAe'), operator, 12, '??'), position('comment.ts', 10));
  assert.deepEqual(at(locate('spaces.js', 'AAAA,UAAU,KAAM'), operator, 12, '??'), position('spaces.ts', 10));
  assert.deepEqual(at(locate('types.js', 'AAAA,UAAU,KAAU'), operator, 12, '??'), position('types.ts', 10));
});

test('a finding keeps its offset only inside the copied run of its segment', () => {
  // The segment starts at column 0 of both texts; the transform changed `d` to `X`, so the run is `abc`.
  const copied = copiedColumns();
  const segment = { line: 0, generated: 0, original: 0 };
  const at = (column: number, token: string) =>
    copied(segment, column, { code: 'abcdef', range: [column, column + token.length] }, 'abcXef');
  assert.equal(at(1, 'b'), 1);
  assert.equal(at(4, 'e'), null);
  assert.equal(at(2, 'c'), 2);
  assert.equal(at(2, 'cd'), null);
});

test('a long line with one segment costs one pass over the line', t => {
  // A minified bundle of a megabyte on one line that a plugin copied as it is: one segment for the whole line.
  const line = `${'x'.repeat(1 << 20)};`;
  const root = createProject(t, { 'src/a.js': `${line}\n` });
  const locate = sourceMapLocate({ path: join(root, 'src/out/a.js') }, () => ({
    version: 3,
    sources: ['../a.js'],
    names: [],
    mappings: 'AAAA',
  }));
  const started = performance.now();
  let last = null;
  for (let column = 0; column < line.length; column += 50) {
    last = { column, place: locate({ line: 1, column }, { code: line, range: [column, column + 1] }) };
  }
  const elapsed = performance.now() - started;
  // 20 000 findings, each exact; a comparison of the whole prefix of each took seconds.
  assert.equal(last?.place?.column, last?.column);
  assert.ok(elapsed < 1000, `${elapsed} ms`);
});

describe('the lowering of the bundler', () => {
  // Two lookbehind assertions (syntax) on lines 1 and 2, and `Intl.Segmenter` (an API) on line 3.
  const CODE = 'const a = /(?<=a)b/;\nconst b = /(?<=c)d/;\nconst c = new Intl.Segmenter();\n';
  const LOOKBEHIND = 'javascript.regular_expressions.lookbehind_assertion';
  const STATIC_BLOCK = 'javascript.classes.static.initialization_blocks';

  async function run(
    t: TestContext,
    lower: Lower | undefined,
    allow: string[] = [],
    code = CODE,
    reportsUnused = true,
  ) {
    const root = createProject(t, {});
    const state = new PluginState({ targets: 'Safari >= 15.6, Firefox >= 115', allow }, root);
    const errors: string[] = [];
    const context: ModuleContext = {
      error: m => errors.push(m),
      warn: assert.fail,
      addWatchFile() {},
      addMissingFile() {},
    };
    const file = { path: join(root, 'src/a.ts') };
    const record = await checkModule(state, code, file, context, { lower, reportsUnused });
    return { errors, usedEntries: [...record.used] };
  }
  const features = (errors: string[]) =>
    errors.map(error => /:(\d+):\d+ \(position in the transpiled module\): (\S+)/.exec(error)?.slice(1).join(' '));

  test('a syntax finding goes when the lowered code lacks the feature; other findings stay', async t => {
    const { errors } = await run(t, async () => ({
      code: 'const a = 1;\nconst b = 2;\nconst c = new Intl.Segmenter();\n',
    }));
    assert.deepEqual(features(errors), ['3 javascript.builtins.Intl.Segmenter']);
  });

  test('the map of the lowering tells which finding of a repeated feature stays', async t => {
    // Line 1 loses its assertion. The map: line 1 to line 1, line 2 column 10 to line 2 column 10.
    const lowered = {
      code: 'const a = 1;\nconst b = /(?<=c)d/;\n',
      map: { version: 3, sources: ['a.ts'], names: [], mappings: 'AAAA;AACA,UAAU' },
    };
    assert.deepEqual(features((await run(t, async () => lowered)).errors), [
      `2 ${LOOKBEHIND}`,
      '3 javascript.builtins.Intl.Segmenter',
    ]);
    // Without a map the plugin cannot tell them apart, and both stay.
    const unmapped = await run(t, async () => ({ code: lowered.code }));
    assert.deepEqual(features(unmapped.errors), [
      `1 ${LOOKBEHIND}`,
      `2 ${LOOKBEHIND}`,
      '3 javascript.builtins.Intl.Segmenter',
    ]);
  });

  test('a segment of another source than the checked code gives no sure place', async t => {
    // As the map of the repeated feature above, but its segment of line 2 names `b.ts`: its line 1, column 10 has
    // the same text as the checked code, yet it is no place in the checked code, so both assertions stay.
    const lowered = {
      code: 'const a = 1;\nconst b = /(?<=c)d/;\n',
      map: { version: 3, sources: ['a.ts', 'b.ts'], names: [], mappings: 'AAAA;AACA,UCAU' },
    };
    assert.deepEqual(features((await run(t, async () => lowered)).errors), [
      `1 ${LOOKBEHIND}`,
      `2 ${LOOKBEHIND}`,
      '3 javascript.builtins.Intl.Segmenter',
    ]);
  });

  test('the map of the lowering gives a sure answer only for one finding per place; otherwise all stay', async t => {
    // Three assertions on one line; the lowering drops the first one.
    const code = 'const a = /(?<=a)b/, b = /(?<=c)d/, c = /(?<=e)f/;\n';
    const lowered = 'const a = 1, b = /(?<=c)d/, c = /(?<=e)f/;\n';
    const columns = (mappings: string) =>
      run(
        t,
        async () => ({ code: lowered, map: { version: 3, sources: ['a.ts'], names: [], mappings } }),
        [],
        code,
      ).then(({ errors }) => errors.map(error => /:\d+:(\d+) \(position in the transpiled module\)/.exec(error)?.[1]));
    // One segment holds the whole line: the first and the second assertion share it, so all three stay.
    assert.deepEqual(await columns('AAAA'), ['12', '27', '42']);
    // Column 32 of the lowered code comes from column 40, and the end of the line from column 20, between the
    // first and the second assertion. The text before the second one differs from the text that the map names,
    // so the map gives no sure place for it, and all three stay: the survivor at column 27 is not dropped.
    assert.deepEqual(await columns('AAAA,gCAAwC,UAApB'), ['12', '27', '42']);
  });

  test('the lowering adds no finding, and its failure keeps the findings', async t => {
    const added = await run(t, async () => ({ code: 'class A {\n  static {}\n}\n' }));
    assert.ok(!added.errors.some(error => error.includes(STATIC_BLOCK)), added.errors.join('\n'));
    assert.deepEqual(
      features(
        (
          await run(t, async () => {
            throw new Error('no engine');
          })
        ).errors,
      ).length,
      3,
    );
    assert.deepEqual(features((await run(t, async () => null)).errors).length, 3);
    assert.deepEqual(features((await run(t, undefined)).errors).length, 3);
  });

  test('an allow entry of syntax that the bundler lowers is not used', async t => {
    // The static block is a reported finding, which starts the lowering; the entry suppresses the assertions.
    const code = `class A {\n  static {}\n}\n${CODE}`;
    const usedEntries = async (lower: Lower | undefined) => (await run(t, lower, [LOOKBEHIND], code)).usedEntries;
    assert.deepEqual(await usedEntries(undefined), [0]);
    assert.deepEqual(await usedEntries(async () => ({ code: 'const a = /(?<=a)b/;\n' })), [0]);
    assert.deepEqual(await usedEntries(async () => ({ code: 'const a = 1;\n' })), []);
  });

  test('an entry that suppressed the only syntax of a module starts the lowering', async t => {
    // No syntax finding is reported: the entry suppresses both assertions, `Intl.Segmenter` is an API.
    let lowered = 0;
    const lower: Lower = async () => {
      lowered += 1;
      return { code: 'const a = 1;\nconst b = 2;\nconst c = new Intl.Segmenter();\n' };
    };
    const { errors, usedEntries } = await run(t, lower, [LOOKBEHIND]);
    assert.equal(lowered, 1);
    assert.deepEqual(usedEntries, []);
    assert.deepEqual(features(errors), ['3 javascript.builtins.Intl.Segmenter']);
    // An entry of an API keeps the module from the lowering.
    await run(t, lower, ['javascript.builtins.Intl.Segmenter'], 'new Intl.Segmenter();\n');
    assert.equal(lowered, 1);
    // A bundler without the report of unused entries does not lower for an entry.
    assert.deepEqual((await run(t, lower, [LOOKBEHIND], CODE, false)).usedEntries, [0]);
    assert.equal(lowered, 1);
  });
});

test('Vite older than 8 has no lowering: one warning per build, and the syntax findings stay', async t => {
  // A stub of Vite 7: it has no `transformWithOxc`.
  const root = createProject(t, {
    'node_modules/vite/package.json': JSON.stringify({
      name: 'vite',
      version: '7.1.0',
      type: 'module',
      main: 'index.js',
    }),
    'node_modules/vite/index.js': "export const version = '7.1.0';\n",
  });
  const lower = viteLower({ config: { root, build: { target: 'safari15' } } });
  assert.ok(lower);
  const file = { path: join(root, 'src/a.ts') };
  await assert.rejects(
    lower('class A {\n  static {}\n}\n', file),
    (error: unknown) =>
      error instanceof LoweringEngineError &&
      error.message ===
        'cannot lower as Vite does: Vite 8 or later is needed for the lowering check; syntax findings stay',
  );
  const state = new PluginState({ targets: 'Safari >= 15.6' }, root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const context: ModuleContext = {
    error: message => errors.push(message),
    warn: message => warnings.push(message),
    addWatchFile() {},
    addMissingFile() {},
  };
  state.startBuild();
  for (const name of ['a', 'b']) {
    await checkModule(state, 'class A {\n  static {}\n}\n', { path: join(root, `src/${name}.ts`) }, context, { lower });
  }
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.deepEqual(warnings, [
    '[compatgate] cannot lower as Vite does: Vite 8 or later is needed for the lowering check; syntax findings stay',
  ]);
});
