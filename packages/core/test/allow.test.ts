import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';

import { createProject, editFile, FAKE_ROOT, fakePath } from '@compatgate/test-utils';
import { AllowConfigError, findAllowFile as findFrom } from '../src-js/allow.ts';
import type { AllowEntry } from '../src-js/allow.ts';
import { clearCaches, clock } from '../src-js/configuration.ts';
import { resolveConfiguration, type ConfigurationOptions } from './resolve.ts';
import { configLookupDirectory } from '../src-js/lookup.ts';

beforeEach(() => clearCaches());

// The clock of the checks without a snapshot stands still: a call checks the configs of a directory at most once in
// 250 ms. `later` moves it on.
let time = 0;
const realNow = clock.now;
clock.now = () => time;
after(() => {
  clock.now = realNow;
});

function later(): void {
  time += 1000;
}

// The targets are given: these tests read compatgate.jsonc only.
const TARGETS = 'Chrome >= 97';

/** The project config and the configs that its entries come from, as `loadAllow` gave them before. */
interface Loaded {
  path: string | null;
  entries: readonly AllowEntry[];
  files: readonly string[];
}

function findAllowFile(filename: string, baseDir: string = process.cwd()): string | null {
  return findFrom(configLookupDirectory(filename, baseDir)).path;
}

/** The entries of compatgate.jsonc above `filename`, without options. */
function loadAllow(filename: string, baseDir?: string): Loaded {
  const configuration = resolveConfiguration(filename, { targets: TARGETS, baseDir });
  return { path: findAllowFile(filename, baseDir), entries: configuration.entries, files: configuration.watch };
}

function resolveAllow(filename: string, options: Omit<ConfigurationOptions, 'targets'> = {}): readonly AllowEntry[] {
  return resolveConfiguration(filename, { targets: TARGETS, ...options }).entries;
}

/** An entry without its source, for the comparisons that do not need it. */
function plain(entry: AllowEntry): Omit<AllowEntry, 'source'> {
  const { source: _, ...rest } = entry;
  return rest;
}

afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

/** Loads the config of a file in `directory`: the lookup finds `directory`/compatgate.jsonc first. */
function loadIn(directory: string): Loaded {
  return loadAllow(join(directory, 'a.ts'));
}

test('finds compatgate.jsonc above the file and reads comments and both entry forms', () => {
  const root = createProject({
    'compatgate.jsonc': `{
      // Closed by a core-js polyfill
      "allow": [
        "api.structuredClone",
        { "feature": "api.ResizeObserver", "packages": ["some-lib"], "files": ["src/desktop/**"] },
      ],
    }`,
    'src/a.ts': '',
  });
  const config = loadAllow(join(root, 'src/a.ts'));
  assert.equal(config.path, join(root, 'compatgate.jsonc'));
  const source = (index: number) => ({ file: join(root, 'compatgate.jsonc'), index });
  assert.deepEqual(config.entries, [
    { feature: 'api.structuredClone', packages: [], files: [], baseDir: root, origin: 'own', source: source(0) },
    {
      feature: 'api.ResizeObserver',
      packages: ['some-lib'],
      files: ['src/desktop/**'],
      baseDir: root,
      origin: 'own',
      source: source(1),
    },
  ]);
});

test('returns no entries without a config', () => {
  const root = createProject({ 'a.ts': '' });
  assert.deepEqual(loadAllow(join(root, 'a.ts')), { path: null, entries: [], files: [] });
});

test('extends a relative file and a package, inherited entries first', () => {
  const root = createProject({
    'node_modules/@company/compat-allow/package.json': JSON.stringify({ name: '@company/compat-allow' }),
    'node_modules/@company/compat-allow/compatgate.jsonc': '{ "allow": ["api.A"] }',
    'shared/base.jsonc': '{ "allow": ["api.B"] }',
    'compatgate.jsonc': '{ "extends": ["@company/compat-allow", "./shared/base.jsonc"], "allow": ["api.C"] }',
  });
  const features = loadIn(root).entries.map(entry => entry.feature);
  assert.deepEqual(features, ['api.A', 'api.B', 'api.C']);
});

test('the same file reached twice through extends is not a cycle', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": ["api.A"] }',
    'b.jsonc': '{ "extends": "./base.jsonc" }',
    'c.jsonc': '{ "extends": "./base.jsonc" }',
    'compatgate.jsonc': '{ "extends": ["./b.jsonc", "./c.jsonc"] }',
  });
  assert.equal(loadIn(root).entries.length, 2);
});

test('a circular extends is an error', () => {
  const root = createProject({
    'compatgate.jsonc': '{ "extends": "./b.jsonc" }',
    'b.jsonc': '{ "extends": "./compatgate.jsonc" }',
  });
  assert.throws(() => loadIn(root), AllowConfigError);
});

test('invalid content is an error that names the file', () => {
  const root = createProject({
    'syntax/compatgate.jsonc': '{ "allow": [ }',
    'shape/compatgate.jsonc': '{ "allow": [{ "feature": 1 }] }',
    'key/compatgate.jsonc': '{ "allow": [{ "feature": "api.A", "reason": "x" }] }',
  });
  for (const name of ['syntax', 'shape', 'key']) {
    assert.throws(
      () => loadIn(join(root, name)),
      (error: unknown) => {
        assert.ok(error instanceof AllowConfigError);
        assert.ok(error.message.includes(join(root, name, 'compatgate.jsonc')), error.message);
        return true;
      },
    );
  }
});

test('a missing relative extends names the config that references it', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "extends": "./missing.jsonc" }' });
  const config = join(root, 'compatgate.jsonc');
  assert.throws(
    () => loadIn(root),
    (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.ok(error.message.includes(config), error.message);
      assert.ok(error.message.includes('missing.jsonc'), error.message);
      return true;
    },
  );
});

test('extends may name a jsonc file inside a package', () => {
  const root = createProject({
    'node_modules/@co/allow/package.json': JSON.stringify({ name: '@co/allow' }),
    'node_modules/@co/allow/strict.jsonc': '{ "allow": ["api.S"] }',
    'compatgate.jsonc': '{ "extends": "@co/allow/strict.jsonc" }',
  });
  assert.deepEqual(
    loadIn(root).entries.map(entry => entry.feature),
    ['api.S'],
  );
});

test('an unresolvable package names the file it looked for', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "extends": "@co/nothing" }' });
  assert.throws(() => loadIn(root), /@co\/nothing\/compatgate\.jsonc/);
});

test('an inline entry takes the form of compatgate.jsonc and names the options', () => {
  const inline = (allow: unknown[], baseDir = FAKE_ROOT) =>
    resolveAllow(fakePath('p', 'a.ts'), { allow: allow as never, baseDir, where: 'settings.compatgate' });
  assert.deepEqual(inline(['api.structuredClone']), [
    {
      feature: 'api.structuredClone',
      packages: [],
      files: [],
      baseDir: FAKE_ROOT,
      origin: 'own',
      source: { options: 'settings.compatgate', index: 0 },
    },
  ]);
  assert.deepEqual(inline(['api.b', { feature: 'api.a', packages: 'lib', files: ['src/**'] }]).map(plain)[1], {
    feature: 'api.a',
    packages: ['lib'],
    files: ['src/**'],
    baseDir: FAKE_ROOT,
    origin: 'own',
  });
  // The directory of the entry wins over the option.
  assert.equal(inline([{ feature: 'api.a', baseDir: fakePath('q') }])[0]?.baseDir, fakePath('q'));
  assert.equal(resolveAllow(fakePath('p', 'a.ts'), { allow: ['api.a'] })[0]?.baseDir, process.cwd());
  // A relative directory would never match the absolute paths that a linter or a bundler passes.
  assert.equal(inline([{ feature: 'api.a', baseDir: 'sub' }])[0]?.baseDir, resolve('sub'));
  assert.equal(inline(['api.a'], 'sub')[0]?.baseDir, resolve('sub'));
});

test('an invalid inline entry is an allow error; a value of another type is an options error', () => {
  // The values come from user configs, so their types are not checked at compile time.
  const values: unknown[] = [
    { feature: 42 },
    { feature: 'api.a', reason: 'x' },
    { feature: 'api.a', files: [1] },
    { feature: 'api.a', origin: 'own' },
  ];
  for (const value of values) {
    assert.throws(
      () => resolveAllow(fakePath('p', 'a.ts'), { allow: [value as string], baseDir: FAKE_ROOT }),
      (error: unknown) => {
        assert.ok(error instanceof AllowConfigError);
        assert.equal(error.code, 'COMPATGATE_ALLOW');
        return true;
      },
    );
  }
  // A value that is neither a string nor an object is an error of the options: see readConfigurationOptions.
  assert.throws(
    () => resolveAllow(fakePath('p', 'a.ts'), { allow: [42 as never] }),
    /^OptionsError: options\.allow\[0\]/,
  );
});

test('compatgate.jsonc does not accept baseDir: the directory of the file is the base', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "allow": [{ "feature": "api.a", "baseDir": "/x" }] }' });
  assert.throws(() => loadIn(root), /unknown key "baseDir"/);
});

test('compatgate.jsonc does not accept origin: the loader sets it', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "allow": [{ "feature": "api.a", "origin": "inherited" }] }' });
  assert.throws(() => loadIn(root), /unknown key "origin"/);
});

test('entries of the file are own, entries of its extends are inherited', () => {
  const root = createProject({
    'base/compatgate.jsonc': '{ "extends": "../deep.jsonc", "allow": ["api.B"] }',
    'deep.jsonc': '{ "allow": ["api.D"] }',
    'compatgate.jsonc': '{ "extends": "./base/compatgate.jsonc", "allow": ["api.C"] }',
    'a.ts': '',
  });
  const marks = (entries: readonly { feature: string; origin: string }[]) =>
    entries.map(e => `${e.feature}:${e.origin}`);
  assert.deepEqual(marks(loadAllow(join(root, 'a.ts')).entries), ['api.D:inherited', 'api.B:inherited', 'api.C:own']);
  // The same file as the config of its own directory has its own entries.
  assert.deepEqual(marks(loadIn(join(root, 'base')).entries), ['api.D:inherited', 'api.B:own']);
});

function features(config: { entries: readonly { feature: string }[] }): string[] {
  return config.entries.map(entry => entry.feature);
}

test('an edit of compatgate.jsonc is seen without clearCaches', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "allow": ["api.A"] }', 'src/a.ts': '' });
  const filename = join(root, 'src/a.ts');
  assert.deepEqual(features(loadAllow(filename)), ['api.A']);
  editFile(join(root, 'compatgate.jsonc'), '{ "allow": ["api.B"] }');
  later();
  assert.deepEqual(features(loadAllow(filename)), ['api.B']);
});

test('an edit of a file in extends is seen without clearCaches', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": ["api.A"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc" }',
    'a.ts': '',
  });
  assert.deepEqual(features(loadAllow(join(root, 'a.ts'))), ['api.A']);
  editFile(join(root, 'base.jsonc'), '{ "allow": ["api.B"] }');
  later();
  assert.deepEqual(features(loadAllow(join(root, 'a.ts'))), ['api.B']);
});

test('a new compatgate.jsonc in a closer directory is seen after clearCaches', () => {
  const root = createProject({ 'compatgate.jsonc': '{ "allow": ["api.A"] }', 'src/a.ts': '' });
  const filename = join(root, 'src/a.ts');
  assert.deepEqual(features(loadAllow(filename, root)), ['api.A']);
  writeFileSync(join(root, 'src/compatgate.jsonc'), '{ "allow": ["api.B"] }');
  later();
  // Only the project root is watched for a new config.
  assert.deepEqual(features(loadAllow(filename, root)), ['api.A']);
  clearCaches();
  assert.deepEqual(loadAllow(filename, root), {
    path: join(root, 'src/compatgate.jsonc'),
    entries: [
      {
        feature: 'api.B',
        packages: [],
        files: [],
        baseDir: join(root, 'src'),
        origin: 'own',
        source: { file: join(root, 'src/compatgate.jsonc'), index: 0 },
      },
    ],
    files: [join(root, 'src/compatgate.jsonc')],
  });
});

test('an unchanged config and its extends are read once', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": ["api.A"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc", "allow": ["api.B"] }',
    'src/a.ts': '',
    'src/b.ts': '',
  });
  // allow.ts imports `readFileSync` by name: the sync makes the import see the mock.
  const read = mock.method(fs, 'readFileSync');
  syncBuiltinESMExports();
  const count = (name: string) => read.mock.calls.filter(call => call.arguments[0] === join(root, name)).length;
  for (let i = 0; i < 3; i++) {
    loadAllow(join(root, 'src/a.ts'));
    loadAllow(join(root, 'src/b.ts'));
    loadIn(root);
  }
  assert.equal(count('compatgate.jsonc'), 1);
  assert.equal(count('base.jsonc'), 1);
  // clearCaches still drops what is read.
  clearCaches();
  loadAllow(join(root, 'src/a.ts'));
  assert.equal(count('compatgate.jsonc'), 2);
});

test('a deleted file in extends is an error on the next load', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": ["api.A"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc" }',
  });
  loadIn(root);
  fs.rmSync(join(root, 'base.jsonc'));
  later();
  assert.throws(() => loadIn(root), /missing file/);
});

test('resolveAllow without extends gives the entries of compatgate.jsonc or allow', () => {
  const root = createProject({
    'compatgate.jsonc': '{ "allow": ["api.A"] }',
    'src/a.ts': '',
  });
  const filename = join(root, 'src/a.ts');
  assert.deepEqual(resolveAllow(filename), loadAllow(filename).entries);
  assert.deepEqual(resolveAllow(filename, { allow: ['api.C'], baseDir: root }).map(plain), [
    { feature: 'api.C', packages: [], files: [], baseDir: root, origin: 'own' },
  ]);
});

test('resolveAllow puts the entries of extends first and marks them inherited', () => {
  // The base package is installed next to the builder, not above the checked files.
  const root = createProject({
    'builder/node_modules/@builder/allow/package.json': JSON.stringify({ name: '@builder/allow' }),
    'builder/node_modules/@builder/allow/compatgate.jsonc': '{ "allow": ["api.Base"] }',
    'service/compatgate.jsonc': '{ "allow": ["api.Own"] }',
    'service/src/a.ts': '',
    'lonely/a.ts': '',
  });
  const marks = (entries: readonly { feature: string; origin: string }[]) =>
    entries.map(e => `${e.feature}:${e.origin}`);
  // The package name resolves from baseDir, not from the checked file.
  const options = { extends: ['@builder/allow'], baseDir: join(root, 'builder') };
  assert.throws(
    () => resolveAllow(join(root, 'service/src/a.ts'), { ...options, baseDir: join(root, 'service') }),
    /cannot resolve "@builder\/allow\/compatgate\.jsonc"/,
  );
  assert.deepEqual(marks(resolveAllow(join(root, 'service/src/a.ts'), options)), ['api.Base:inherited', 'api.Own:own']);
  // Without compatgate.jsonc the base applies alone.
  assert.deepEqual(marks(resolveAllow(join(root, 'lonely/a.ts'), options)), ['api.Base:inherited']);
  // The base also comes before inline entries.
  assert.deepEqual(marks(resolveAllow(join(root, 'lonely/a.ts'), { ...options, allow: ['api.Inline'] })), [
    'api.Base:inherited',
    'api.Inline:own',
  ]);
});

test('resolveAllow takes a path in extends, absolute or relative to baseDir', () => {
  const root = createProject({ 'shared/base.jsonc': '{ "allow": ["api.Base"] }', 'a.ts': '' });
  const filename = join(root, 'a.ts');
  for (const target of [join(root, 'shared/base.jsonc'), './shared/base.jsonc']) {
    assert.deepEqual(
      resolveAllow(filename, { extends: [target], baseDir: root }).map(e => e.feature),
      ['api.Base'],
    );
  }
  assert.throws(
    () => resolveAllow(filename, { extends: ['./missing.jsonc'], baseDir: root }),
    (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.equal(error.message, '"extends" option points to a missing file: missing.jsonc');
      assert.equal(error.path, undefined);
      return true;
    },
  );
  assert.throws(
    () => resolveAllow(filename, { extends: ['@co/nothing'], baseDir: root }),
    /^AllowConfigError: "extends" option: cannot resolve "@co\/nothing\/compatgate\.jsonc"\./,
  );
});

test('a missing config in extends is an allow error that names the file', () => {
  const root = createProject({ 'a.ts': '' });
  assert.throws(
    () => resolveAllow(join(root, 'a.ts'), { extends: [join(root, 'nope.jsonc')] }),
    (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.equal(error.code, 'COMPATGATE_ALLOW');
      assert.equal(error.message, `"extends" option points to a missing file: ${join(root, 'nope.jsonc')}`);
      return true;
    },
  );
});

test('the cached entries cannot be changed by a caller', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": [{ "feature": "api.A", "files": ["src/**"] }] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc", "allow": ["api.B"] }',
    'a.ts': '',
  });
  const filename = join(root, 'a.ts');
  const before = structuredClone(loadAllow(filename).entries);
  const { entries } = loadAllow(filename);
  const [entry] = entries;
  assert.ok(entry);
  // The types forbid these writes; the casts stand for a caller in JavaScript. Modules are strict code:
  // a write to a frozen object throws.
  assert.throws(() => (entries as AllowEntry[]).push(entry), TypeError);
  assert.throws(() => ((entry as { feature: string }).feature = 'api.X'), TypeError);
  assert.throws(() => (entry.files as string[]).push('**'), TypeError);
  const [base] = resolveAllow(filename, { extends: ['./base.jsonc'], baseDir: root });
  assert.ok(base);
  assert.throws(() => (base.packages as string[]).push('lib'), TypeError);
  assert.deepEqual(loadAllow(filename).entries, before);
});

test('a config lists the files that its entries come from: the config and its extends', () => {
  const linked = createProject({
    'node_modules/@co/allow/package.json': JSON.stringify({ name: '@co/allow' }),
    'node_modules/@co/allow/compatgate.jsonc': '{ "allow": ["api.A"] }',
    'shared/base.jsonc': '{ "extends": "@co/allow", "allow": ["api.B"] }',
    'compatgate.jsonc': '{ "extends": "./shared/base.jsonc", "allow": ["api.C"] }',
    'a.ts': '',
  });
  // A package resolves to its real path, and the tmpdir of macOS is a symlink.
  const root = fs.realpathSync(linked);
  const files = [
    join(root, 'compatgate.jsonc'),
    join(root, 'shared/base.jsonc'),
    join(root, 'node_modules/@co/allow/compatgate.jsonc'),
  ];
  assert.deepEqual([...loadAllow(join(root, 'a.ts')).files].sort(), [...files].sort());
  // The cached config gives the same list.
  assert.deepEqual([...loadAllow(join(root, 'a.ts')).files].sort(), [...files].sort());
});

test('a configuration watches the files of extends and the project config', () => {
  const root = createProject({
    'base.jsonc': '{ "allow": ["api.Base"] }',
    'compatgate.jsonc': '{ "allow": ["api.Own"] }',
    'src/a.ts': '',
  });
  const filename = join(root, 'src/a.ts');
  const options = { targets: TARGETS, extends: ['./base.jsonc'], baseDir: root };
  const found = resolveConfiguration(filename, options);
  assert.deepEqual(found.entries, resolveAllow(filename, options));
  assert.deepEqual([...found.watch].sort(), [join(root, 'base.jsonc'), join(root, 'compatgate.jsonc')].sort());

  const inline = resolveConfiguration(filename, { ...options, allow: ['api.Inline'] });
  assert.deepEqual(inline.watch, [join(root, 'base.jsonc')]);
  assert.deepEqual(inline.missing, []);
});

test('an allow error names the file in error', () => {
  const root = createProject({
    'broken/compatgate.jsonc': '{ "allow": [1] }',
    'base/base.jsonc': '{ "allow": [',
    'base/compatgate.jsonc': '{ "extends": "./base.jsonc" }',
    'missing/compatgate.jsonc': '{ "extends": "./none.jsonc" }',
  });
  const pathOf = (run: () => unknown) => {
    try {
      run();
    } catch (error) {
      assert.ok(error instanceof AllowConfigError, String(error));
      return error.path;
    }
    assert.fail('no error');
  };
  assert.equal(
    pathOf(() => loadIn(join(root, 'broken'))),
    join(root, 'broken/compatgate.jsonc'),
  );
  // An error in a file of `extends` names that file.
  assert.equal(
    pathOf(() => loadIn(join(root, 'base'))),
    join(root, 'base/base.jsonc'),
  );
  // A missing file of `extends` is fixed in the config that names it.
  assert.equal(
    pathOf(() => loadIn(join(root, 'missing'))),
    join(root, 'missing/compatgate.jsonc'),
  );
  // An inline entry has no file.
  assert.equal(
    pathOf(() => resolveAllow(join(root, 'a.ts'), { allow: [{ feature: 1 } as never] })),
    undefined,
  );
});

test('a file inside node_modules takes compatgate.jsonc of the project, not of the dependency', () => {
  const root = createProject({
    'compatgate.jsonc': '{ "allow": [{ "feature": "api.structuredClone", "packages": ["lib"] }] }',
    'node_modules/lib/compatgate.jsonc': '{ "allow": [] }',
    'node_modules/lib/src/compatgate.jsonc': '{ "allow": ["api.Other"] }',
    'node_modules/lib/src/a.js': '',
    'node_modules/.pnpm/lib@1.0.0/node_modules/lib/compatgate.jsonc': '{ "allow": [] }',
    'node_modules/.pnpm/lib@1.0.0/node_modules/lib/a.js': '',
  });
  const own = [
    {
      feature: 'api.structuredClone',
      packages: ['lib'],
      files: [],
      baseDir: root,
      origin: 'own',
      source: { file: join(root, 'compatgate.jsonc'), index: 0 },
    },
  ];
  for (const file of ['node_modules/lib/src/a.js', 'node_modules/.pnpm/lib@1.0.0/node_modules/lib/a.js']) {
    const filename = join(root, file);
    assert.equal(findAllowFile(filename), join(root, 'compatgate.jsonc'), file);
    assert.deepEqual(
      loadAllow(filename),
      { path: join(root, 'compatgate.jsonc'), entries: own, files: [join(root, 'compatgate.jsonc')] },
      file,
    );
    assert.deepEqual(resolveAllow(filename), own, file);
  }
});

test('a file inside node_modules of a project without compatgate.jsonc has no entries', () => {
  const root = createProject({
    'node_modules/lib/compatgate.jsonc': '{ "allow": ["api.structuredClone"] }',
    'node_modules/lib/a.js': '',
  });
  assert.equal(findAllowFile(join(root, 'node_modules/lib/a.js')), null);
  assert.deepEqual(loadAllow(join(root, 'node_modules/lib/a.js')), { entries: [], path: null, files: [] });
});

test('the allow option does not accept origin: compatgate sets it', () => {
  for (const origin of ['inherited', 'own']) {
    assert.throws(
      () => resolveAllow(fakePath('p', 'a.js'), { allow: ['api.a', { feature: 'api.b', origin } as never] }),
      (error: unknown) =>
        error instanceof AllowConfigError && error.message.startsWith('options.allow[1]: unknown key "origin"'),
      origin,
    );
  }
  // The directory of an entry stays an option.
  assert.equal(
    resolveAllow(fakePath('p', 'a.js'), { allow: [{ feature: 'api.a', baseDir: fakePath('q') }] })[0]?.baseDir,
    fakePath('q'),
  );
});

test('a project inside node_modules keeps its own compatgate.jsonc when baseDir is the project', () => {
  const root = createProject({
    'nm/compatgate.jsonc': '{ "allow": ["api.Parent"] }',
    'nm/node_modules/proj/compatgate.jsonc': '{ "allow": ["api.Own"] }',
    'nm/node_modules/proj/src/a.js': '',
    'nm/node_modules/proj/node_modules/lib/compatgate.jsonc': '{ "allow": [] }',
    'nm/node_modules/proj/node_modules/lib/a.js': '',
  });
  const proj = join(root, 'nm/node_modules/proj');
  const own = join(proj, 'compatgate.jsonc');
  for (const file of ['src/a.js', 'node_modules/lib/a.js']) {
    const filename = join(proj, file);
    assert.equal(findAllowFile(filename, proj), own, file);
    assert.equal(loadAllow(filename, proj).path, own, file);
    assert.deepEqual(
      resolveAllow(filename, { baseDir: proj }).map(entry => entry.feature),
      ['api.Own'],
      file,
    );
  }
  // Without the root the project counts as a dependency.
  assert.equal(findAllowFile(join(proj, 'src/a.js'), root), join(root, 'nm/compatgate.jsonc'));
});
