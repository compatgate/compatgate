import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import browserslist from 'browserslist';

import { cachedDirectories, clock, compiledTargets, counters, DIRECTORY_LIMIT } from '../src-js/configuration.ts';
import { describeAllowIssue } from '../src-js/describe.ts';
import { readConfigurationOptions } from '../src-js/options.ts';
import {
  AllowConfigError,
  ConfigError,
  OptionsError,
  TargetsConfigError,
  clearCaches,
  createResolver,
  type Configuration,
} from '../src-js/index.ts';
import { resolveConfiguration } from './resolve.ts';

const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

beforeEach(() => clearCaches());

// The clock of the checks without a snapshot stands still: a call checks the configs of a directory at most once in
// 250 ms. `later` moves it on.
let time = 0;
const realNow = clock.now;
clock.now = () => time;
after(() => {
  clock.now = realNow;
});

function later(milliseconds = 1000): void {
  time += milliseconds;
}

// The places of a new config in a directory, in the order of `missing`.
const PLACES = ['.browserslistrc', 'browserslist', 'package.json', 'compatgate.jsonc'];
const places = (directory: string) => PLACES.map(name => join(directory, name));

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Record<string, string>): string {
  // The tmpdir of macOS is a symlink: a package resolves to its real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'compatgate-configuration-')));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

// Moves the modification time forward: two writes in a row may get the same time on a coarse file system.
function edit(path: string, content: string, seconds = 10): void {
  writeFileSync(path, content);
  const time = new Date(Date.now() + seconds * 1000);
  utimesSync(path, time, time);
}

const features = (entries: readonly { feature: string }[]) => entries.map(entry => entry.feature);

/** The place of a new entry that the advice of a finding in `filename` names. */
function allowIn(configuration: Configuration, filename: string): string {
  const [finding] = configuration.checker.check('structuredClone(1);', filename).findings;
  return /to (\S+)\.$/.exec(finding?.message ?? '')?.[1] ?? '';
}

test('100 files in 10 directories without configs take one full computation', () => {
  const root = project({
    '.browserslistrc': `${TARGETS}\n`,
    'compatgate.jsonc': '{ "allow": ["api.structuredClone"] }',
  });
  const before = counters.computations;
  const configurations = new Set<unknown>();
  for (let directory = 0; directory < 10; directory += 1) {
    for (let file = 0; file < 10; file += 1) {
      const configuration = resolveConfiguration(join(root, `src/d${directory}/deep/f${file}.ts`), { baseDir: root });
      configurations.add(configuration.checker);
    }
  }
  assert.equal(counters.computations - before, 1);
  assert.equal(configurations.size, 1);
});

test('a configuration gives the targets, the entries, the checker and the files to watch', () => {
  const root = project({
    '.browserslistrc': `${TARGETS}\n`,
    'base.jsonc': '{ "allow": ["api.Base"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc", "allow": ["api.structuredClone", "api.Typo"] }',
  });
  const configuration = resolveConfiguration(join(root, 'src/app/a.ts'), { baseDir: root });
  assert.equal(configuration.targets, TARGETS);
  assert.deepEqual(configuration.entries, [
    {
      feature: 'api.Base',
      packages: [],
      files: [],
      baseDir: root,
      origin: 'inherited',
      source: { file: join(root, 'base.jsonc'), index: 0 },
    },
    {
      feature: 'api.structuredClone',
      packages: [],
      files: [],
      baseDir: root,
      origin: 'own',
      source: { file: join(root, 'compatgate.jsonc'), index: 0 },
    },
    {
      feature: 'api.Typo',
      packages: [],
      files: [],
      baseDir: root,
      origin: 'own',
      source: { file: join(root, 'compatgate.jsonc'), index: 1 },
    },
  ]);
  assert.deepEqual(configuration.issues, [
    {
      index: 0,
      kind: 'unknown-feature',
      message: 'base.jsonc, allow[0]: unknown feature "api.Base". compatgate ignores the entry.',
    },
    {
      index: 2,
      kind: 'unknown-feature',
      message:
        'compatgate.jsonc, allow[1]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
    },
  ]);
  assert.deepEqual(configuration.ignoredBrowsers, []);
  assert.deepEqual(
    [...configuration.watch].sort(),
    [join(root, '.browserslistrc'), join(root, 'base.jsonc'), join(root, 'compatgate.jsonc')].sort(),
  );
  // Only the project root is watched for a new config: a browserslist config next to the found one is a conflict.
  assert.deepEqual(configuration.missing, [join(root, 'browserslist'), join(root, 'package.json')]);
  const result = configuration.checker.check('structuredClone(1);', join(root, 'src/app/a.ts'));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.suppressed, [{ index: 1, kind: 'api' }]);
  assert.ok(Object.isFrozen(configuration));
  assert.ok(Object.isFrozen(configuration.entries));
});

test('the advice of a finding names the compatgate.jsonc that takes the entries of the project', () => {
  const root = project({
    'base.jsonc': '{ "allow": ["api.fetch"] }',
    'compatgate.jsonc': '{ "allow": [] }',
    'src/lib/compatgate.jsonc': '{ "extends": "../../base.jsonc" }',
  });
  const options = { targets: TARGETS, baseDir: root };
  const file = join(root, 'src/a.ts');
  assert.equal(allowIn(resolveConfiguration(file, options), file), 'compatgate.jsonc');
  // A config without entries of its own is still the place of a new entry.
  const deep = join(root, 'src/lib/deep/a.ts');
  assert.equal(allowIn(resolveConfiguration(deep, options), deep), 'src/lib/compatgate.jsonc');
  // The options give the entries: the advice names them.
  const inline = resolveConfiguration(file, { ...options, allow: [], where: 'settings.compatgate' });
  assert.equal(allowIn(inline, file), 'settings.compatgate.allow');
  // Without a config the advice names the config to make.
  const bare = project({});
  const other = join(bare, 'a.ts');
  assert.equal(allowIn(resolveConfiguration(other, { targets: TARGETS, baseDir: bare }), other), 'compatgate.jsonc');
  // A config outside the project root keeps its absolute path.
  const outside = resolveConfiguration(deep, { targets: TARGETS, baseDir: join(root, 'src/lib/deep') });
  assert.equal(allowIn(outside, deep), join(root, 'src/lib/compatgate.jsonc'));
});

test('the files of one directory take one lookup of the directory to start from', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": [] }' });
  const before = counters.lookups;
  for (let directory = 0; directory < 10; directory += 1) {
    for (let file = 0; file < 10; file += 1) {
      resolveConfiguration(join(root, `src/d${directory}/f${file}.ts`), { targets: TARGETS, baseDir: root });
    }
  }
  assert.equal(counters.lookups - before, 10);
  // A dependency takes the configs of the project, as the lookup without the cache gives.
  const name = join(root, 'node_modules/lib/compatgate.jsonc/../index.js');
  const dependency = resolveConfiguration(name, { targets: TARGETS, baseDir: root });
  assert.deepEqual(dependency.missing, []);
  assert.equal(allowIn(dependency, name), 'compatgate.jsonc');
});

test('a name that ends in . or .. leaves the lookup of its directory uncached', () => {
  const root = project({
    'compatgate.jsonc': '{ "allow": [] }',
    'src/lib/compatgate.jsonc': '{ "allow": [] }',
  });
  const options = { targets: TARGETS, baseDir: root };
  for (const name of ['.', '..']) {
    clearCaches();
    // The directory of `src/lib/..` is `src`, not `src/lib`: its siblings in `src/lib` would take `src`.
    // `join` would drop the segment.
    resolveConfiguration(`${join(root, 'src/lib')}/${name}`, options);
    const sibling = join(root, 'src/lib/a.ts');
    assert.equal(allowIn(resolveConfiguration(sibling, options), sibling), 'src/lib/compatgate.jsonc', name);
    // The other order: the directory of a sibling is not the directory of the name.
    const dotted = resolveConfiguration(`${join(root, 'src/lib')}/${name}`, options);
    assert.equal(allowIn(dotted, sibling), 'compatgate.jsonc', name);
  }
});

test('options replace the lookup, and their entries name the options', () => {
  const root = project({ 'base.jsonc': '{ "allow": ["api.Base"] }' });
  const configuration = resolveConfiguration(join(root, 'src/a.ts'), {
    targets: 'Chrome >= 97',
    allow: ['api.structuredClone', { feature: 'api.fetch', files: 'src/**' }],
    extends: ['./base.jsonc'],
    baseDir: root,
    where: 'settings.compatgate',
  });
  assert.equal(configuration.targets, 'Chrome >= 97');
  assert.deepEqual(
    configuration.entries.map(entry => [entry.feature, entry.origin, entry.source]),
    [
      ['api.Base', 'inherited', { file: join(root, 'base.jsonc'), index: 0 }],
      ['api.structuredClone', 'own', { options: 'settings.compatgate', index: 0 }],
      ['api.fetch', 'own', { options: 'settings.compatgate', index: 1 }],
    ],
  );
  assert.deepEqual(configuration.watch, [join(root, 'base.jsonc')]);
  assert.deepEqual(configuration.missing, []);
});

test('an edit of a config computes the configuration again', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'compatgate.jsonc': '{ "allow": ["api.A"] }' });
  const filename = join(root, 'src/a.ts');
  const first = resolveConfiguration(filename, { baseDir: root });
  assert.equal(resolveConfiguration(filename, { baseDir: root }), first);
  edit(join(root, 'compatgate.jsonc'), '{ "allow": ["api.B"] }');
  later();
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root }).entries), ['api.B']);
  edit(join(root, '.browserslistrc'), 'Chrome >= 100\n', 20);
  later();
  assert.equal(resolveConfiguration(filename, { baseDir: root }).targets, 'Chrome >= 100');
});

test('a new compatgate.jsonc in the project root applies; a nested one applies after clearCaches', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'src/deep/a.ts': '' });
  const filename = join(root, 'src/deep/a.ts');
  const sibling = join(root, 'src/b.ts');
  const first = resolveConfiguration(filename, { baseDir: root });
  assert.deepEqual(features(first.entries), []);
  assert.deepEqual(first.missing, [
    join(root, 'browserslist'),
    join(root, 'package.json'),
    join(root, 'compatgate.jsonc'),
  ]);
  assert.deepEqual(features(resolveConfiguration(sibling, { baseDir: root }).entries), []);
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "allow": ["api.A"] }');
  later();
  const before = counters.computations;
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root }).entries), ['api.A']);
  assert.deepEqual(features(resolveConfiguration(sibling, { baseDir: root }).entries), ['api.A']);
  assert.equal(counters.computations - before, 1);
  // A new config below the root is not watched: it applies after a restart.
  writeFileSync(join(root, 'src/compatgate.jsonc'), '{ "allow": ["api.B"] }');
  later();
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root, snapshot: {} }).entries), ['api.A']);
  clearCaches();
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root }).entries), ['api.B']);
});

test('the places of a new config are the project root only; a config above the root applies and is watched', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'proj/src/deep/a.ts': '' });
  const proj = join(root, 'proj');
  const filename = join(proj, 'src/deep/a.ts');
  const first = resolveConfiguration(filename, { baseDir: proj });
  assert.equal(first.targets, 'Chrome >= 97');
  assert.ok(first.watch.includes(join(root, '.browserslistrc')));
  assert.deepEqual(first.missing, places(proj));
  // A file outside the root watches no place of a new config.
  assert.deepEqual(resolveConfiguration(join(root, 'other/a.ts'), { baseDir: proj }).missing, []);
  // An edit of the config above the root applies.
  edit(join(root, '.browserslistrc'), 'Chrome >= 100\n');
  later();
  assert.equal(resolveConfiguration(filename, { baseDir: proj }).targets, 'Chrome >= 100');
  // A new config in the root applies. Without a snapshot a call checks the configs at most once in 250 ms.
  writeFileSync(join(proj, '.browserslistrc'), 'Chrome >= 110\n');
  later(249);
  assert.equal(resolveConfiguration(filename, { baseDir: proj }).targets, 'Chrome >= 100');
  later(1);
  assert.equal(resolveConfiguration(filename, { baseDir: proj }).targets, 'Chrome >= 110');
  // A new config between the file and the root applies after a restart, also with a new snapshot.
  writeFileSync(join(proj, 'src/browserslist'), 'Chrome >= 120\n');
  assert.equal(resolveConfiguration(filename, { baseDir: proj, snapshot: {} }).targets, 'Chrome >= 110');
  clearCaches();
  assert.equal(resolveConfiguration(filename, { baseDir: proj, snapshot: {} }).targets, 'Chrome >= 120');
});

test('only the found browserslist config is watched; a package.json on the way applies after clearCaches', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'src/package.json': '{}', 'src/deep/lib/a.ts': '' });
  const filename = join(root, 'src/deep/lib/a.ts');
  const first = resolveConfiguration(filename, { baseDir: root, allow: [] });
  assert.equal(first.targets, 'Chrome >= 97');
  assert.deepEqual(first.watch, [join(root, '.browserslistrc')]);
  edit(join(root, 'src/package.json'), JSON.stringify({ browserslist: ['Chrome >= 100'] }));
  later();
  assert.equal(resolveConfiguration(filename, { baseDir: root, allow: [] }).targets, 'Chrome >= 97');
  clearCaches();
  assert.equal(resolveConfiguration(filename, { baseDir: root, allow: [] }).targets, 'Chrome >= 100');
  // The package.json of the root is a place of a new config: its browserslist field applies.
  const bare = project({ 'package.json': '{}', 'src/a.ts': '' });
  const options = { baseDir: bare, allow: [], defaultTargets: 'Chrome >= 97' };
  const own = resolveConfiguration(join(bare, 'src/a.ts'), options);
  assert.deepEqual(own.watch, [join(bare, 'package.json')]);
  assert.deepEqual(own.missing, [join(bare, '.browserslistrc'), join(bare, 'browserslist')]);
  edit(join(bare, 'package.json'), JSON.stringify({ browserslist: ['Chrome >= 110'] }));
  later();
  assert.equal(resolveConfiguration(join(bare, 'src/a.ts'), options).targets, 'Chrome >= 110');
});

test('calls within 250 ms check the configs once, in any number of directories; a check stats the watched files', t => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'compatgate.jsonc': '{ "allow": [] }' });
  for (let directory = 0; directory < 1000; directory += 1) {
    resolveConfiguration(join(root, `d${directory}/a.ts`), { baseDir: root });
  }
  later();
  // file-state.ts imports `statSync` by name: the sync makes the import see the mock.
  const stat = t.mock.method(fs, 'statSync');
  syncBuiltinESMExports();
  t.after(() => {
    stat.mock.restore();
    syncBuiltinESMExports();
  });
  const before = counters.checks;
  for (let directory = 0; directory < 1000; directory += 1) {
    resolveConfiguration(join(root, `d${directory}/b.ts`), { baseDir: root });
  }
  assert.equal(counters.checks - before, 1);
  // The configs and the places of a new config in the root.
  assert.deepEqual(stat.mock.calls.map(call => call.arguments[0]).sort(), places(root).sort());
  later(249);
  resolveConfiguration(join(root, 'd0/a.ts'), { baseDir: root });
  assert.equal(counters.checks - before, 1);
  later(1);
  resolveConfiguration(join(root, 'd0/a.ts'), { baseDir: root });
  assert.equal(counters.checks - before, 2);
});

test('with BROWSERSLIST or BROWSERSLIST_CONFIG the places of a browserslist config do not apply', () => {
  const root = project({ '.browserslistrc': 'Chrome >= 97\n', 'custom/config': 'Chrome >= 100\n' });
  const filename = join(root, 'src/a.ts');
  withEnvironment({ BROWSERSLIST_CONFIG: join(root, 'custom/config') }, () => {
    const configuration = resolveConfiguration(filename, { baseDir: root, allow: [] });
    assert.equal(configuration.targets, 'Chrome >= 100');
    assert.deepEqual(configuration.watch, [join(root, 'custom/config')]);
    assert.deepEqual(configuration.missing, []);
  });
  withEnvironment({ BROWSERSLIST: 'Chrome >= 110' }, () => {
    const configuration = resolveConfiguration(filename, { baseDir: root, allow: [] });
    assert.equal(configuration.targets, 'Chrome >= 110');
    assert.deepEqual(configuration.watch, []);
    assert.deepEqual(configuration.missing, []);
  });
});

test('with BROWSERSLIST a package.json does not make its directory compute a configuration', () => {
  const root = project({ 'a/package.json': '{}', 'b/package.json': '{}' });
  withEnvironment({ BROWSERSLIST: 'Chrome >= 110' }, () => {
    const before = counters.computations;
    for (const path of ['x.ts', 'a/x.ts', 'b/x.ts']) {
      assert.equal(resolveConfiguration(join(root, path), { baseDir: root, allow: [] }).targets, 'Chrome >= 110');
    }
    assert.equal(counters.computations - before, 1);
  });
});

test('an edit of a found config reaches every directory at the next check, a new one too', () => {
  const root = project({ 'a/.browserslistrc': 'Chrome >= 97\n', 'a/b/package.json': '{}', 'a/c/package.json': '{}' });
  assert.equal(resolveConfiguration(join(root, 'a/b/x.ts'), { baseDir: root, allow: [] }).targets, 'Chrome >= 97');
  edit(join(root, 'a/.browserslistrc'), 'Chrome >= 100\n');
  // The configurations between two checks come from the same reads of the configs.
  assert.equal(resolveConfiguration(join(root, 'a/c/x.ts'), { baseDir: root, allow: [] }).targets, 'Chrome >= 97');
  later();
  assert.equal(resolveConfiguration(join(root, 'a/c/x.ts'), { baseDir: root, allow: [] }).targets, 'Chrome >= 100');
  assert.equal(resolveConfiguration(join(root, 'a/b/x.ts'), { baseDir: root, allow: [] }).targets, 'Chrome >= 100');
});

test('a change of any watched config resets every configuration and clears browserslist once', t => {
  const root = project({
    'a/.browserslistrc': 'Chrome >= 97\n',
    'b/package.json': JSON.stringify({ browserslist: ['Chrome >= 98'] }),
    'compatgate.jsonc': '{ "allow": ["api.A"] }',
  });
  const clear = t.mock.method(browserslist, 'clearCaches');
  const a = join(root, 'a/x.ts');
  const b = join(root, 'b/x.ts');
  assert.equal(resolveConfiguration(a, { baseDir: root }).targets, 'Chrome >= 97');
  assert.equal(resolveConfiguration(b, { baseDir: root }).targets, 'Chrome >= 98');
  // browserslist warns of old data once per process: each clear would warn again.
  assert.equal(clear.mock.callCount(), 0);
  edit(join(root, 'compatgate.jsonc'), '{ "allow": ["api.B"] }');
  later();
  const before = counters.computations;
  assert.deepEqual(features(resolveConfiguration(a, { baseDir: root }).entries), ['api.B']);
  assert.deepEqual(features(resolveConfiguration(b, { baseDir: root }).entries), ['api.B']);
  assert.equal(counters.computations - before, 2);
  assert.equal(clear.mock.callCount(), 1);
  edit(join(root, 'b/package.json'), JSON.stringify({ browserslist: ['Chrome >= 99'] }));
  later();
  assert.equal(resolveConfiguration(b, { baseDir: root }).targets, 'Chrome >= 99');
  assert.equal(resolveConfiguration(a, { baseDir: root }).targets, 'Chrome >= 97');
  assert.equal(clear.mock.callCount(), 2);
});

function withEnvironment(variables: Record<string, string>, run: () => void): void {
  const saved = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, variables);
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('directories with the same configs share the entries and the checker', () => {
  const root = project({
    'compatgate.jsonc': '{ "allow": ["api.A"] }',
    'a/package.json': '{}',
    'b/package.json': '{}',
  });
  const first = resolveConfiguration(join(root, 'a/x.ts'), { targets: TARGETS, baseDir: root });
  const second = resolveConfiguration(join(root, 'b/x.ts'), { targets: TARGETS, baseDir: root });
  assert.equal(first.entries, second.entries);
  assert.equal(first.checker, second.checker);
});

test('the issues name the browsers without data', () => {
  const configuration = resolveConfiguration('/p/a.ts', { targets: 'Chrome >= 97, op_mini all, ie 11', allow: [] });
  assert.deepEqual(configuration.ignoredBrowsers, ['ie']);
});

test('an entry of the options may not set origin or source: compatgate sets them', () => {
  for (const key of ['origin', 'source']) {
    assert.throws(
      () => resolveConfiguration('/p/a.ts', { targets: TARGETS, allow: [{ feature: 'api.a', [key]: 'own' } as never] }),
      (error: unknown) =>
        error instanceof AllowConfigError && error.message.startsWith(`options.allow[0]: unknown key "${key}"`),
      key,
    );
  }
  assert.throws(
    () =>
      resolveConfiguration('/p/a.ts', {
        targets: TARGETS,
        allow: [{ feature: 'api.a', origin: 'own' } as never],
        where: 'settings.compatgate',
      }),
    /^AllowConfigError: settings\.compatgate\.allow\[0\]: unknown key "origin"/,
  );
});

test('a config error names the files to watch for its fix', () => {
  const root = project({
    'broken/compatgate.jsonc': '{ "allow": [1] }',
    'targets/.browserslistrc': 'Chrom >= 97\n',
    'conflict/.browserslistrc': 'Chrome >= 97\n',
    'conflict/package.json': JSON.stringify({ browserslist: ['Chrome >= 97'] }),
  });
  assert.throws(
    () => resolveConfiguration(join(root, 'broken/src/a.ts'), { targets: TARGETS, baseDir: root }),
    (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.deepEqual(error.watch, [join(root, 'broken/compatgate.jsonc')]);
      return true;
    },
  );
  assert.throws(
    () => resolveConfiguration(join(root, 'conflict/a.ts'), { baseDir: root }),
    (error: unknown) => {
      assert.ok(error instanceof TargetsConfigError);
      assert.deepEqual(
        [...error.watch].sort(),
        [join(root, 'conflict/.browserslistrc'), join(root, 'conflict/package.json')].sort(),
      );
      // A place outside the project root is not watched for a new config.
      assert.deepEqual(error.missing, []);
      return true;
    },
  );
  // An invalid query fails in browserslist: the error names the config and watches its directory.
  assert.throws(
    () => resolveConfiguration(join(root, 'targets/a.ts'), { baseDir: root, allow: [] }),
    (error: unknown) => {
      assert.ok(error instanceof TargetsConfigError);
      // The message names the config relative to the project root, `watch` names it by its absolute path.
      assert.ok(error.message.startsWith(`${join('targets', '.browserslistrc')}: Chrom >= 97: `), error.message);
      assert.deepEqual(error.watch, [join(root, 'targets/.browserslistrc')]);
      return true;
    },
  );
  // A query of the options names the option.
  assert.throws(
    () => resolveConfiguration(join(root, 'a.ts'), { targets: 'Chrom >= 97', allow: [], where: 'settings.compatgate' }),
    (error: unknown) =>
      error instanceof TargetsConfigError && error.message.startsWith('settings.compatgate.targets: Chrom >= 97: '),
  );
});

test('a targets error of the options watches no browserslist config; one without a directory stops at the root', () => {
  const root = project({ 'package.json': '{}', 'proj/.browserslistrc': 'Chrome >= 97\n', 'proj/package.json': '{}' });
  const proj = join(root, 'proj');
  const filename = join(proj, 'src/a.ts');
  // The `targets` option replaces the lookup: no browserslist config can fix its error.
  assert.throws(
    () => resolveConfiguration(filename, { targets: 'Chrom >= 97', baseDir: proj, allow: [] }),
    (error: unknown) => error instanceof TargetsConfigError && error.watch.length === 0 && error.missing.length === 0,
  );
  // An invalid defaultTargets names no directory: the places up to the root are watched, not the ones above it.
  rmSync(join(proj, '.browserslistrc'));
  assert.throws(
    () => resolveConfiguration(filename, { defaultTargets: 'Chrom >= 97', baseDir: proj, allow: [] }),
    (error: unknown) => {
      assert.ok(error instanceof TargetsConfigError);
      assert.deepEqual(error.watch, [join(proj, 'package.json')]);
      assert.deepEqual(error.missing, [join(proj, '.browserslistrc'), join(proj, 'browserslist')]);
      return true;
    },
  );
});

test('an error of the binding is a config error that watches every config of the configuration', () => {
  const root = project({
    '.browserslistrc': `${TARGETS}\n`,
    'compatgate.jsonc': '{ "allow": [{ "feature": "api.a", "files": ["src/[a"] }] }',
    'nodata/.browserslistrc': 'op_mini all\n',
    'nodata/compatgate.jsonc': '{ "allow": [] }',
  });
  // The binding does not tell which config holds the invalid glob or the targets without data.
  assert.throws(
    () => resolveConfiguration(join(root, 'src/a.ts'), { baseDir: root }),
    (error: unknown) => {
      assert.ok(error instanceof AllowConfigError);
      assert.equal((error.cause as { code?: string }).code, 'COMPATGATE_ALLOW');
      assert.equal(error.path, undefined);
      assert.deepEqual([...error.watch].sort(), [join(root, '.browserslistrc'), join(root, 'compatgate.jsonc')].sort());
      // The places of a browserslist config that would conflict with the found one.
      assert.deepEqual(error.missing, [join(root, 'browserslist'), join(root, 'package.json')]);
      return true;
    },
  );
  assert.throws(
    () => resolveConfiguration(join(root, 'nodata/a.ts'), { baseDir: root }),
    (error: unknown) => {
      assert.ok(error instanceof TargetsConfigError);
      assert.ok(error instanceof ConfigError);
      assert.equal((error.cause as { code?: string }).code, 'COMPATGATE_TARGETS');
      assert.match(error.message, /op_mini all: selects no browser with compatibility data/);
      assert.deepEqual(
        [...error.watch].sort(),
        [join(root, 'nodata/.browserslistrc'), join(root, 'nodata/compatgate.jsonc')].sort(),
      );
      return true;
    },
  );
});

test('the message of an issue names the file and the index of the entry', () => {
  const root = project({
    'base.jsonc': '{ "allow": ["api.BaseTypo"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc", "allow": ["api.fetch", "api.Typo"] }',
  });
  const configuration = resolveConfiguration(join(root, 'a.ts'), { targets: TARGETS, baseDir: root });
  assert.deepEqual(
    configuration.issues.map(issue => issue.message),
    [
      'base.jsonc, allow[0]: unknown feature "api.BaseTypo". compatgate ignores the entry.',
      'compatgate.jsonc, allow[0]: every target browser supports "api.fetch". Remove the entry.',
      'compatgate.jsonc, allow[1]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
    ],
  );
  // A path outside the base directory stays absolute.
  const [issue] = configuration.issues;
  assert.equal(
    describeAllowIssue(issue!, configuration.entries[0]!),
    `${join(root, 'base.jsonc')}, allow[0]: unknown feature "api.BaseTypo". compatgate ignores the entry.`,
  );
  const inline = resolveConfiguration('/p/a.ts', {
    targets: TARGETS,
    allow: ['api.Typo'],
    where: 'settings.compatgate',
  });
  assert.equal(
    inline.issues[0]?.message,
    'settings.compatgate.allow[0]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
  );
});

test('the message of an issue suggests the closest known id', () => {
  const root = project({
    'base.jsonc': '{ "allow": ["api.fetchh"] }',
    'compatgate.jsonc': '{ "extends": "./base.jsonc", "allow": ["api.URL.canParse"] }',
  });
  const configuration = resolveConfiguration(join(root, 'a.ts'), { targets: TARGETS, baseDir: root });
  assert.deepEqual(
    configuration.issues.map(issue => issue.suggestion),
    ['api.fetch', 'api.URL.canParse_static'],
  );
  assert.deepEqual(
    configuration.issues.map(issue => issue.message),
    [
      'base.jsonc, allow[0]: unknown feature "api.fetchh". compatgate ignores the entry. Did you mean "api.fetch"?',
      'compatgate.jsonc, allow[0]: unknown feature "api.URL.canParse". A feature id is a path in ' +
        '@mdn/browser-compat-data, such as "api.structuredClone". Did you mean "api.URL.canParse_static"?',
    ],
  );
});

test('readConfigurationOptions checks the shared options and names the place', () => {
  assert.deepEqual(
    readConfigurationOptions({ targets: 'Chrome >= 97', allow: ['api.a'], syntax: true }, 'settings.compatgate'),
    { targets: 'Chrome >= 97', allow: ['api.a'] },
  );
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ targets: 1 }, /^settings\.compatgate\.targets: expected a string$/],
    [{ defaultTargets: [] }, /^settings\.compatgate\.defaultTargets: expected a string$/],
    [{ allow: 'api.a' }, /^settings\.compatgate\.allow: expected an array of feature ids and entries$/],
    [{ allow: [1] }, /^settings\.compatgate\.allow\[0\]: expected a feature id or an object$/],
    [{ extends: 'a' }, /^settings\.compatgate\.extends: expected an array of strings$/],
  ];
  for (const [options, message] of cases) {
    assert.throws(
      () => readConfigurationOptions(options, 'settings.compatgate'),
      (error: unknown) =>
        error instanceof OptionsError && error.code === 'COMPATGATE_OPTIONS' && message.test(error.message),
      JSON.stringify(options),
    );
  }
  // createResolver checks its options the same way, before the first file.
  assert.throws(() => createResolver({ targets: 1 as never }), /^OptionsError: options\.targets/);
  assert.throws(
    () => createResolver({ allow: 'api.a' as never, where: 'compatgate' }),
    /^OptionsError: compatgate\.allow: expected an array/,
  );
});

test('a config error names the configs inside the project root relative to it, and keeps absolute fields', () => {
  const cases: Record<string, Record<string, string>> = {
    'a syntax error of compatgate.jsonc': { 'compatgate.jsonc': '{ "allow": [ }' },
    'an unknown key': { 'compatgate.jsonc': '{ "alow": [] }' },
    'a missing file of extends': { 'compatgate.jsonc': '{ "extends": "./configs/missing.jsonc" }' },
    'a circular extends': {
      'compatgate.jsonc': '{ "extends": "./configs/a.jsonc" }',
      'configs/a.jsonc': '{ "extends": "./b.jsonc" }',
      'configs/b.jsonc': '{ "extends": "./a.jsonc" }',
    },
    'an invalid query of .browserslistrc': { 'src/.browserslistrc': 'unknown_browser 1\n' },
    'two browserslist configs in one directory': {
      'src/.browserslistrc': 'Chrome >= 97\n',
      'src/package.json': '{ "browserslist": ["Chrome >= 97"] }',
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    const root = project(files);
    assert.throws(
      () => createResolver({ baseDir: root, defaultTargets: TARGETS }).resolve(join(root, 'src/a.ts')),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError, name);
        assert.ok(!error.message.includes(`${root}${sep}`), `${name}: ${error.message}`);
        const fields = error as { path?: string; directory?: string };
        for (const field of [fields.path, fields.directory]) {
          assert.ok(field === undefined || isAbsolute(field), `${name}: ${field}`);
        }
        assert.ok(
          [...error.watch, ...error.missing].every(path => isAbsolute(path)),
          name,
        );
        return true;
      },
      name,
    );
  }
  // The `extends` option names its file too.
  const root = project({});
  assert.throws(
    () => createResolver({ baseDir: root, targets: TARGETS, extends: ['./nope.jsonc'] }).resolve(join(root, 'a.ts')),
    /^AllowConfigError: "extends" option points to a missing file: nope\.jsonc$/,
  );
  // A config outside the project root keeps its absolute path.
  const outer = project({ 'compatgate.jsonc': '{ "alow": [] }' });
  assert.throws(
    () => createResolver({ baseDir: join(outer, 'app'), targets: TARGETS }).resolve(join(outer, 'app/a.ts')),
    (error: unknown) => error instanceof AllowConfigError && error.message.startsWith(join(outer, 'compatgate.jsonc')),
  );
});

test('clearCaches computes the configuration again', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": ["api.A"] }' });
  const first = resolveConfiguration(join(root, 'a.ts'), { targets: TARGETS, baseDir: root });
  clearCaches();
  const second = resolveConfiguration(join(root, 'a.ts'), { targets: TARGETS, baseDir: root });
  assert.notEqual(second, first);
  assert.deepEqual(second.entries, first.entries);
});

test('calls with one snapshot check the configs once; a new snapshot sees an edit', () => {
  const root = project({
    '.browserslistrc': 'Chrome >= 97\n',
    'compatgate.jsonc': '{ "allow": ["api.A"] }',
    'src/a.ts': '',
  });
  const filename = join(root, 'src/a.ts');
  const build = {};
  const before = counters.checks;
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root, snapshot: build }).entries), ['api.A']);
  edit(join(root, 'compatgate.jsonc'), '{ "allow": ["api.B"] }');
  writeFileSync(join(root, 'src/compatgate.jsonc'), '{ "allow": ["api.C"] }');
  // A bundler gives each build a snapshot: the configs of one build stay as the build found them.
  for (let file = 0; file < 10; file += 1) {
    const { entries } = resolveConfiguration(join(root, `src/d${file}/a.ts`), { baseDir: root, snapshot: build });
    assert.deepEqual(features(entries), ['api.A']);
  }
  assert.equal(counters.checks - before, 1);
  // The edit resets every configuration: the new nested config applies too.
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root, snapshot: {} }).entries), ['api.C']);
  assert.equal(counters.checks - before, 2);
  rmSync(join(root, 'src/compatgate.jsonc'));
  // Without a snapshot a call checks the configs at most once in 250 ms.
  later();
  assert.deepEqual(features(resolveConfiguration(filename, { baseDir: root }).entries), ['api.B']);
});

test('check of a resolver checks a file with the checker of its configuration', () => {
  const root = project({
    'compatgate.jsonc': '{ "allow": [{ "feature": "api.structuredClone", "files": "src/ok/**" }] }',
  });
  const resolver = createResolver({ targets: TARGETS, baseDir: root });
  const source = 'structuredClone(1);';
  for (const name of ['src/a.ts', 'src/ok/a.ts']) {
    const filename = join(root, name);
    assert.deepEqual(resolver.check(source, filename), resolver.resolve(filename).checker.check(source, filename));
  }
  assert.equal(resolver.check(source, join(root, 'src/a.ts')).findings.length, 1);
  assert.equal(resolver.check(source, join(root, 'src/ok/a.ts')).findings.length, 0);
  // `parseAs` selects the parser, the name matches `files`.
  const component = join(root, 'src/ok/App.vue');
  assert.deepEqual(resolver.check(source, component, { parseAs: `${component}.ts` }).suppressed, [
    { index: 0, kind: 'api' },
  ]);
  assert.equal(resolver.check(source, component).parseError?.kind, 'unsupported-file');
});

test('calls of one resolver with one snapshot read the options once', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": [] }' });
  const resolver = createResolver({ targets: TARGETS, baseDir: root });
  const snapshot = {};
  const before = counters.scopes;
  for (let file = 0; file < 10; file += 1) {
    resolver.resolve(join(root, `src/f${file}.ts`), { snapshot });
  }
  assert.equal(counters.scopes - before, 1);
  // Another resolver or another snapshot reads the options again: the variables of browserslist may change.
  createResolver({ targets: TARGETS, baseDir: root }).resolve(join(root, 'src/a.ts'), { snapshot });
  resolver.resolve(join(root, 'src/a.ts'), { snapshot: {} });
  resolver.resolve(join(root, 'src/a.ts'));
  resolver.resolve(join(root, 'src/a.ts'));
  assert.equal(counters.scopes - before, 5);
});

test('without where the options are named options everywhere', () => {
  const configuration = resolveConfiguration('/p/a.ts', { targets: TARGETS, allow: ['api.a'] });
  assert.deepEqual(configuration.entries[0]?.source, { options: 'options', index: 0 });
  assert.throws(
    () => resolveConfiguration('/p/a.ts', { targets: TARGETS, allow: [{ feature: 1 } as never] }),
    /^AllowConfigError: options\.allow\[0\]: expected a feature id/,
  );
  assert.throws(() => resolveConfiguration('/p/a.ts', { targets: 1 as never }), /^OptionsError: options\.targets/);
});

test('an inherited entry of a feature of every target names no fix: the project may not own the base', () => {
  const root = project({ 'base.jsonc': '{ "allow": ["api.fetch"] }' });
  const configuration = resolveConfiguration(join(root, 'a.ts'), {
    targets: TARGETS,
    allow: [],
    extends: ['./base.jsonc'],
    baseDir: root,
  });
  assert.equal(
    configuration.issues[0]?.message,
    'base.jsonc, allow[0]: every target browser supports "api.fetch". The entry has no effect.',
  );
});

test('the checkers of one list of entries are bounded: an edit of the targets does not pile them up', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": ["api.structuredClone"] }' });
  let entries: unknown;
  for (let version = 90; version < 96; version += 1) {
    ({ entries } = resolveConfiguration(join(root, 'a.ts'), { targets: `Chrome >= ${version}`, baseDir: root }));
  }
  assert.ok(compiledTargets(entries as never) <= 4, String(compiledTargets(entries as never)));
});

test('the cached directories of one set of options are bounded', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": [] }' });
  for (let index = 0; index <= DIRECTORY_LIMIT; index += 1) {
    resolveConfiguration(join(root, `d${index}`, 'a.ts'), { targets: TARGETS, baseDir: root });
  }
  const cached = cachedDirectories();
  assert.ok(cached.configurations <= DIRECTORY_LIMIT && cached.lookups <= DIRECTORY_LIMIT, JSON.stringify(cached));
  // The configuration stays right after the cache drops the directories.
  assert.deepEqual(resolveConfiguration(join(root, 'd0/a.ts'), { targets: TARGETS, baseDir: root }).entries, []);
});

test('a package.json with browserslist stops the inheritance; one without it does not', () => {
  const root = project({
    '.browserslistrc': 'Chrome >= 97\n',
    'with/package.json': JSON.stringify({ browserslist: ['Firefox >= 115'] }),
    'without/package.json': JSON.stringify({ name: 'without' }),
  });
  assert.equal(resolveConfiguration(join(root, 'with/src/a.ts'), { baseDir: root }).targets, 'Firefox >= 115');
  assert.equal(resolveConfiguration(join(root, 'without/src/a.ts'), { baseDir: root }).targets, 'Chrome >= 97');
});

test('a project without a browserslist config takes defaults with the data of the browserslist package', () => {
  const root = project({ 'compatgate.jsonc': '{ "allow": [] }' });
  const filename = join(root, 'a.ts');
  const configuration = resolveConfiguration(filename, { baseDir: root });
  assert.equal(configuration.targets, 'defaults');
  // browserslist-rs 0.21 had Firefox ESR 140 in defaults, and Firefox lacks URLPattern before 142. iOS Safari 18.5
  // of defaults lacks it for real.
  const urlPattern = configuration.checker.check('new URLPattern({ pathname: "/a" });', filename).findings;
  assert.deepEqual(
    urlPattern.flatMap(finding => finding.unsupported.map(gap => gap.browser)).filter(name => name === 'firefox'),
    [],
  );
  // Each gap names the lowest version of the browser that the package gives for defaults.
  const lowest = new Map<string, number[]>();
  for (const entry of browserslist('defaults')) {
    const [name = '', version = ''] = entry.split(' ');
    const key = BCD_KEYS[name];
    const parts = versionParts(version);
    if (key !== undefined && parts !== undefined && compareParts(parts, lowest.get(key)) < 0) {
      lowest.set(key, parts);
    }
  }
  const source =
    'Promise.try(f); RegExp.escape(s); Math.sumPrecise(a); Error.isError(e); Uint8Array.fromBase64(s); ' +
    'Array.fromAsync(a); new URLPattern({});';
  const gaps = configuration.checker.check(source, filename).findings.flatMap(finding => finding.unsupported);
  assert.ok(gaps.length > 0);
  for (const gap of gaps) {
    assert.deepEqual(versionParts(gap.target), lowest.get(gap.browser), `${gap.browser} ${gap.target}`);
  }
});

// browserslist names of the browsers with data and their BCD keys.
const BCD_KEYS: Record<string, string> = {
  chrome: 'chrome',
  and_chr: 'chrome_android',
  edge: 'edge',
  firefox: 'firefox',
  and_ff: 'firefox_android',
  opera: 'opera',
  op_mob: 'opera_android',
  safari: 'safari',
  ios_saf: 'safari_ios',
  samsung: 'samsunginternet_android',
  android: 'webview_android',
};

/** `18.5-18.7` as `[18, 5, 0]`: a range counts by its lower bound. `undefined` for `TP`. */
function versionParts(text: string): number[] | undefined {
  const parts = (text.split('-')[0] ?? '').split('.').map(Number);
  if (parts.some(Number.isNaN)) {
    return undefined;
  }
  return [0, 1, 2].map(index => parts[index] ?? 0);
}

function compareParts(left: number[], right: number[] | undefined): number {
  if (right === undefined) {
    return -1;
  }
  const index = left.findIndex((part, at) => part !== right[at]);
  return index === -1 ? 0 : (left[index] as number) - (right[index] as number);
}

test('another environment of browserslist gives another configuration', () => {
  const root = project({ '.browserslistrc': '[production]\nChrome >= 97\n\n[development]\nChrome >= 100\n' });
  const filename = join(root, 'a.ts');
  const saved = { BROWSERSLIST_ENV: process.env.BROWSERSLIST_ENV, NODE_ENV: process.env.NODE_ENV };
  try {
    delete process.env.BROWSERSLIST_ENV;
    process.env.NODE_ENV = 'production';
    const production = resolveConfiguration(filename, { baseDir: root });
    assert.equal(production.targets, 'Chrome >= 97');
    process.env.NODE_ENV = 'development';
    assert.equal(resolveConfiguration(filename, { baseDir: root }).targets, 'Chrome >= 100');
    process.env.NODE_ENV = 'production';
    process.env.BROWSERSLIST_ENV = 'development';
    assert.equal(resolveConfiguration(filename, { baseDir: root }).targets, 'Chrome >= 100');
    delete process.env.BROWSERSLIST_ENV;
    assert.equal(resolveConfiguration(filename, { baseDir: root }), production);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
