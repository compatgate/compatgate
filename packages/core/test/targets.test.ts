import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import browserslist from 'browserslist';

import { createProject } from '@compatgate/test-utils';
import { configLookupDirectory } from '../src-js/lookup.ts';
import { TargetsConfigError, clearTargetsCache, resolveTargetsIn, type ResolvedTargets } from '../src-js/targets.ts';

/**
 * The targets of `filename`, as `resolveConfiguration` finds them, without the files to watch. browserslist keeps
 * what it reads until the core resets its caches: the tests here edit the configs between the calls.
 */
function resolveTargetsConfig(filename: string, options: Options = {}): Found {
  clearTargetsCache();
  const { query, browsers, path } = resolveTargetsIn(
    configLookupDirectory(filename, options.baseDir ?? process.cwd()),
    options.defaultTargets,
  );
  return { query, browsers, path };
}

type Found = Pick<ResolvedTargets, 'query' | 'browsers' | 'path'>;
interface Options {
  defaultTargets?: string;
  baseDir?: string;
}

/** What `resolveTargetsIn` gives for a query of a config: the browsers are the ones of browserslist. */
function found(query: string, path: string | null, expanded = query): Found {
  return { query, path, browsers: browserslist(expanded) };
}

/** The browsers of `filename`. */
function resolveTargets(filename: string, options: Options = {}): string[] {
  return resolveTargetsConfig(filename, options).browsers;
}

test('reads .browserslistrc above the file', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 100\nFirefox >= 120\n', 'src/a.js': '' });
  assert.deepEqual(resolveTargets(join(root, 'src/a.js')), browserslist('Chrome >= 100, Firefox >= 120'));
});

test('reads the browserslist field of package.json', () => {
  const root = createProject({ 'package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }), 'a.js': '' });
  assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('Safari >= 16'));
});

test('reads a browserslist field of package.json that is one string', () => {
  // browserslist accepts a string as well as a list in package.json.
  const root = createProject({
    'package.json': JSON.stringify({ browserslist: 'Chrome >= 97, Firefox >= 120' }),
    'a.js': '',
  });
  assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('Chrome >= 97, Firefox >= 120'));
});

test('reads the query of a config as it is and gives the browsers of browserslist', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 100\nFirefox >= 120\n', 'src/a.js': '' });
  assert.deepEqual(
    resolveTargetsConfig(join(root, 'src/a.js')),
    found('Chrome >= 100, Firefox >= 120', join(root, '.browserslistrc')),
  );
});

test('a project without a config takes the browsers of browserslist for defaults', () => {
  const root = createProject({ 'a.js': '' });
  assert.deepEqual(resolveTargetsConfig(join(root, 'a.js')), found('defaults', null));
  // The npm package resolves defaults with its own data: Firefox ESR and the latest Chrome are recent.
  assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('defaults'));
});

test('falls back to defaultTargets and then to defaults', () => {
  const root = createProject({ 'a.js': '' });
  assert.deepEqual(
    resolveTargets(join(root, 'a.js'), { defaultTargets: 'Chrome >= 97' }),
    browserslist('Chrome >= 97'),
  );
  assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('defaults'));
});

test('expands extends relative to the file, not to the process directory', () => {
  const root = createProject({
    'node_modules/browserslist-config-base/package.json': JSON.stringify({ name: 'browserslist-config-base' }),
    'node_modules/browserslist-config-base/index.js': "module.exports = ['Safari >= 16'];",
    'node_modules/browserslist-config-foo/package.json': JSON.stringify({ name: 'browserslist-config-foo' }),
    'node_modules/browserslist-config-foo/index.js':
      "module.exports = ['Chrome >= 100', 'extends browserslist-config-base'];",
    '.browserslistrc': 'extends browserslist-config-foo\nFirefox >= 120\n',
    'src/a.js': '',
  });
  assert.deepEqual(
    resolveTargetsConfig(join(root, 'src/a.js')),
    found(
      'extends browserslist-config-foo, Firefox >= 120',
      join(root, '.browserslistrc'),
      'Chrome >= 100, Safari >= 16, Firefox >= 120',
    ),
  );
});

test('picks the environment section of a shared config', () => {
  const root = createProject({
    'node_modules/browserslist-config-env/package.json': JSON.stringify({ name: 'browserslist-config-env' }),
    'node_modules/browserslist-config-env/index.js':
      "module.exports = { defaults: ['Chrome >= 90'], legacy: ['Chrome >= 50'] };",
    '.browserslistrc': 'extends browserslist-config-env\n',
    'a.js': '',
  });
  const saved = process.env.BROWSERSLIST_ENV;
  try {
    delete process.env.BROWSERSLIST_ENV;
    assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('Chrome >= 90'));
    process.env.BROWSERSLIST_ENV = 'legacy';
    assert.deepEqual(resolveTargets(join(root, 'a.js')), browserslist('Chrome >= 50'));
  } finally {
    if (saved === undefined) {
      delete process.env.BROWSERSLIST_ENV;
    } else {
      process.env.BROWSERSLIST_ENV = saved;
    }
  }
});

test('an extends package that cannot be resolved is an error that names it', () => {
  const root = createProject({ '.browserslistrc': 'extends browserslist-config-missing\n', 'a.js': '' });
  assert.throws(
    () => resolveTargets(join(root, 'a.js')),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.code === 'COMPATGATE_TARGETS' &&
      error.message.startsWith(`${join(root, '.browserslistrc')}: `) &&
      error.message.includes('browserslist-config-missing'),
  );
});

test('an invalid query of a config is a targets error that names the config and its directory', () => {
  const root = createProject({ 'lib/.browserslistrc': 'Chrom >= 97\n', 'lib/a.js': '' });
  assert.throws(
    () => resolveTargets(join(root, 'lib/a.js')),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.code === 'COMPATGATE_TARGETS' &&
      error.message.startsWith(`${join(root, 'lib/.browserslistrc')}: `) &&
      error.message.includes('Chrom >= 97') &&
      error.directory === join(root, 'lib'),
  );
});

test('an invalid default query is a targets error that names the option', () => {
  const root = createProject({ 'a.js': '' });
  assert.throws(
    () => resolveTargets(join(root, 'a.js'), { defaultTargets: 'Chrom >= 97' }),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.message.startsWith('options.defaultTargets: ') &&
      error.message.includes('Chrom >= 97') &&
      error.directory === undefined,
  );
});

test('resolveTargetsConfig names the config file that gives the query', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 100\n', 'src/a.js': '' });
  assert.deepEqual(resolveTargetsConfig(join(root, 'src/a.js')), found('Chrome >= 100', join(root, '.browserslistrc')));
  const pkg = createProject({ 'package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }), 'a.js': '' });
  assert.deepEqual(resolveTargetsConfig(join(pkg, 'a.js')), found('Safari >= 16', join(pkg, 'package.json')));
  const none = createProject({ 'a.js': '' });
  assert.deepEqual(
    resolveTargetsConfig(join(none, 'a.js'), { defaultTargets: 'Chrome >= 97' }),
    found('Chrome >= 97', null),
  );
});

test('an error of browserslist is a targets error with the code', () => {
  const root = createProject({
    '.browserslistrc': 'Chrome >= 100\n',
    'package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }),
    'a.js': '',
  });
  assert.throws(
    () => resolveTargets(join(root, 'a.js')),
    (error: unknown) => {
      assert.ok(error instanceof TargetsConfigError);
      assert.equal(error.code, 'COMPATGATE_TARGETS');
      assert.match(error.message, /contains both \.browserslistrc and package\.json with browsers/);
      return true;
    },
  );
});

test('the files to watch are the config, and the package.json of the root when the lookup reaches the root', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 100\n', 'src/package.json': '{}', 'src/lib/a.js': '' });
  const { watch, missing } = resolveTargetsIn(join(root, 'src/lib'), undefined, 'options', root);
  // A package.json on the way is not watched: a browserslist field added to it applies after a restart.
  assert.deepEqual([...watch.keys()], [join(root, '.browserslistrc')]);
  // A config in the directory of the found one is a conflict. A directory below the root is not watched.
  assert.deepEqual(missing, [join(root, 'browserslist'), join(root, 'package.json')]);
  // A package.json with the browserslist field is the config: a .browserslistrc or browserslist next to it conflicts.
  const pkg = createProject({ 'package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }), 'src/a.js': '' });
  const found = resolveTargetsIn(join(pkg, 'src'), undefined, 'options', pkg);
  assert.deepEqual([...found.watch.keys()], [join(pkg, 'package.json')]);
  assert.deepEqual(found.missing, [join(pkg, '.browserslistrc'), join(pkg, 'browserslist')]);
  // Without a config the places of the root are missing, and none above it. The package.json of the root may get the
  // field.
  const none = createProject({ 'a.js': '' });
  assert.deepEqual(resolveTargetsIn(join(none, 'src'), 'Chrome >= 97', 'options', none).missing, [
    join(none, '.browserslistrc'),
    join(none, 'browserslist'),
    join(none, 'package.json'),
  ]);
  writeFileSync(join(none, 'package.json'), '{}');
  const own = resolveTargetsIn(join(none, 'src'), 'Chrome >= 97', 'options', none);
  assert.deepEqual([...own.watch.keys()], [join(none, 'package.json')]);
  // Without a root, or for a directory outside it, nothing is missing.
  assert.deepEqual(resolveTargetsIn(none, 'Chrome >= 97').missing, []);
  assert.deepEqual(resolveTargetsIn(none, 'Chrome >= 97', 'options', join(none, 'sub')).missing, []);
});

test('a deleted config gives way to the config above it', () => {
  const root = createProject({
    '.browserslistrc': 'Chrome >= 100\n',
    'src/.browserslistrc': 'Chrome >= 110\n',
    'src/a.js': '',
  });
  const filename = join(root, 'src/a.js');
  assert.deepEqual(resolveTargetsConfig(filename), found('Chrome >= 110', join(root, 'src/.browserslistrc')));
  rmSync(join(root, 'src/.browserslistrc'));
  assert.deepEqual(resolveTargetsConfig(filename), found('Chrome >= 100', join(root, '.browserslistrc')));
});

test('a targets error names the directory of the failing config', () => {
  const root = createProject({
    'lib/.browserslistrc': 'Chrome >= 100\n',
    'lib/package.json': JSON.stringify({ browserslist: ['Safari >= 16'] }),
    'lib/a.js': '',
  });
  assert.throws(
    () => resolveTargets(join(root, 'lib/a.js')),
    (error: unknown) => error instanceof TargetsConfigError && error.directory === join(root, 'lib'),
  );
});

test('a file inside node_modules takes the browserslist config of the project, not of the dependency', () => {
  const root = createProject({
    '.browserslistrc': 'Chrome >= 97\n',
    'node_modules/lib/package.json': JSON.stringify({ name: 'lib', browserslist: 'Chrome >= 120' }),
    'node_modules/lib/.browserslistrc': 'Chrome >= 110\n',
    'node_modules/lib/src/a.js': '',
    'node_modules/a/node_modules/b/browserslist': 'Chrome >= 115\n',
    'node_modules/a/node_modules/b/b.js': '',
    'node_modules/.pnpm/c@1.0.0/node_modules/c/package.json': JSON.stringify({ browserslist: ['Chrome >= 125'] }),
    'node_modules/.pnpm/c@1.0.0/node_modules/c/c.js': '',
  });
  const expected = found('Chrome >= 97', join(root, '.browserslistrc'));
  // The dependency has two configs in one directory: the project does not read them, so they are no error.
  assert.deepEqual(resolveTargetsConfig(join(root, 'node_modules/lib/src/a.js')), expected);
  assert.deepEqual(resolveTargetsConfig(join(root, 'node_modules/a/node_modules/b/b.js')), expected);
  assert.deepEqual(resolveTargetsConfig(join(root, 'node_modules/.pnpm/c@1.0.0/node_modules/c/c.js')), expected);
  assert.deepEqual(resolveTargets(join(root, 'node_modules/lib/src/a.js')), browserslist('Chrome >= 97'));
});

test('a file inside node_modules of a project without a config takes the default query', () => {
  const root = createProject({
    'node_modules/lib/package.json': JSON.stringify({ name: 'lib', browserslist: 'Chrome >= 120' }),
    'node_modules/lib/a.js': '',
  });
  assert.deepEqual(
    resolveTargetsConfig(join(root, 'node_modules/lib/a.js'), { defaultTargets: 'Chrome >= 97' }),
    found('Chrome >= 97', null),
  );
});

test('extends takes the names that browserslist takes', () => {
  const root = createProject({
    'node_modules/browserslist-config-co/package.json': JSON.stringify({ name: 'browserslist-config-co' }),
    'node_modules/browserslist-config-co/index.js': "module.exports = ['Chrome >= 100'];",
    'node_modules/browserslist-config-co/legacy.js': "module.exports = ['Chrome >= 50'];",
    'node_modules/@co/browserslist-config/package.json': JSON.stringify({ name: '@co/browserslist-config' }),
    'node_modules/@co/browserslist-config/index.js': "module.exports = ['Safari >= 16'];",
    'node_modules/@co/browserslist-config-web/package.json': JSON.stringify({ name: '@co/browserslist-config-web' }),
    'node_modules/@co/browserslist-config-web/index.js': "module.exports = ['Firefox >= 120'];",
    '.browserslistrc':
      'extends browserslist-config-co\nextends browserslist-config-co/legacy\n' +
      'extends @co/browserslist-config\nextends @co/browserslist-config-web\n',
    'a.js': '',
  });
  assert.deepEqual(
    resolveTargets(join(root, 'a.js')),
    browserslist('Chrome >= 100, Chrome >= 50, Safari >= 16, Firefox >= 120'),
  );
});

test('extends with a name that browserslist rejects is a targets error, and the module does not load', () => {
  const root = createProject({
    'node_modules/evil/package.json': JSON.stringify({ name: 'evil' }),
    'node_modules/evil/index.js': "globalThis.compatgateEvilLoaded = true; module.exports = ['Chrome >= 1'];",
    'node_modules/browserslist-config-co/package.json': JSON.stringify({ name: 'browserslist-config-co' }),
    'node_modules/browserslist-config-co/index.js': "module.exports = ['Chrome >= 100'];",
    'shared.js': "globalThis.compatgateEvilLoaded = true; module.exports = ['Chrome >= 1'];",
    'a.js': '',
  });
  for (const [index, name] of [
    'evil',
    './shared.js',
    join(root, 'shared.js'),
    '../shared',
    'browserslist-config-co/../../evil',
    'browserslist-config-co\\index',
    'browserslist-config-co/node_modules/x',
    '@co/evil',
  ].entries()) {
    writeFileSync(join(root, '.browserslistrc'), `extends ${name}\n`);
    // A later modification time: the edit must show within the resolution of the clock.
    const later = new Date(Date.now() + 5_000 + index * 1_000);
    utimesSync(join(root, '.browserslistrc'), later, later);
    assert.throws(
      () => resolveTargets(join(root, 'a.js')),
      (error: unknown) =>
        error instanceof TargetsConfigError && error.message.startsWith(`${join(root, '.browserslistrc')}: `),
      name,
    );
  }
  assert.equal((globalThis as { compatgateEvilLoaded?: boolean }).compatgateEvilLoaded, undefined);
});

test('extends resolves as browserslist does: from the process directory, then from the file', () => {
  // A monorepo of strict pnpm: the root config names a package that only the app installs.
  const root = createProject({
    '.browserslistrc': 'extends browserslist-config-co\nFirefox >= 120\n',
    'packages/app/node_modules/browserslist-config-co/package.json': JSON.stringify({ name: 'browserslist-config-co' }),
    'packages/app/node_modules/browserslist-config-co/index.js': "module.exports = ['Chrome >= 100'];",
    'packages/app/src/a.js': '',
    'packages/other/src/a.js': '',
    'tool/node_modules/browserslist-config-tool/package.json': JSON.stringify({ name: 'browserslist-config-tool' }),
    'tool/node_modules/browserslist-config-tool/index.js': "module.exports = ['Safari >= 16'];",
    'site/.browserslistrc': 'extends browserslist-config-tool\n',
    'site/a.js': '',
  });
  assert.deepEqual(resolveTargets(join(root, 'packages/app/src/a.js')), browserslist('Chrome >= 100, Firefox >= 120'));
  // Another package resolves it neither from the process directory nor from its file. The message names the config.
  assert.throws(
    () => resolveTargets(join(root, 'packages/other/src/a.js')),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.message.startsWith(`${join(root, '.browserslistrc')}: `) &&
      error.message.includes('browserslist-config-co'),
  );
  // The process directory comes first: a tool that runs from its own directory gives its shared config.
  const cwd = process.cwd();
  process.chdir(join(root, 'tool'));
  try {
    assert.deepEqual(resolveTargets(join(root, 'site/a.js')), browserslist('Safari >= 16'));
  } finally {
    process.chdir(cwd);
  }
});

test('a dependency file resolves extends from the project side, not from inside the dependency', () => {
  const root = createProject({
    '.browserslistrc': 'extends browserslist-config-co\n',
    'node_modules/browserslist-config-co/package.json': JSON.stringify({ name: 'browserslist-config-co' }),
    'node_modules/browserslist-config-co/index.js': "module.exports = ['Chrome >= 100'];",
    'node_modules/lib/node_modules/browserslist-config-co/package.json': JSON.stringify({
      name: 'browserslist-config-co',
    }),
    'node_modules/lib/node_modules/browserslist-config-co/index.js': "module.exports = ['Chrome >= 1'];",
    'node_modules/lib/a.js': '',
  });
  assert.deepEqual(resolveTargets(join(root, 'node_modules/lib/a.js')), browserslist('Chrome >= 100'));
});

test('a project inside node_modules keeps its own config when baseDir is the project', () => {
  const root = createProject({
    'nm/.browserslistrc': 'Chrome >= 50\n',
    'nm/node_modules/proj/.browserslistrc': 'Chrome >= 97\n',
    'nm/node_modules/proj/src/a.js': '',
    'nm/node_modules/proj/node_modules/lib/package.json': JSON.stringify({ browserslist: 'Chrome >= 120' }),
    'nm/node_modules/proj/node_modules/lib/a.js': '',
  });
  const proj = join(root, 'nm/node_modules/proj');
  const own = found('Chrome >= 97', join(proj, '.browserslistrc'));
  assert.deepEqual(resolveTargetsConfig(join(proj, 'src/a.js'), { baseDir: proj }), own);
  // A dependency of the project still takes the config of the project.
  assert.deepEqual(resolveTargetsConfig(join(proj, 'node_modules/lib/a.js'), { baseDir: proj }), own);
  // Without the root the project counts as a dependency: the lookup starts above the outermost node_modules.
  assert.deepEqual(
    resolveTargetsConfig(join(proj, 'src/a.js'), { baseDir: root }),
    found('Chrome >= 50', join(root, 'nm/.browserslistrc')),
  );
});

test('the BROWSERSLIST variable replaces the config', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 100\n', 'a.js': '' });
  const saved = process.env.BROWSERSLIST;
  try {
    process.env.BROWSERSLIST = 'Firefox >= 120';
    assert.deepEqual(resolveTargetsConfig(join(root, 'a.js')), found('Firefox >= 120', null));
    process.env.BROWSERSLIST = 'Chrom >= 97';
    assert.throws(
      () => resolveTargets(join(root, 'a.js')),
      (error: unknown) => error instanceof TargetsConfigError && error.message.startsWith('BROWSERSLIST: '),
    );
  } finally {
    if (saved === undefined) {
      delete process.env.BROWSERSLIST;
    } else {
      process.env.BROWSERSLIST = saved;
    }
  }
});

test('a circular extends is a targets error that names the config', () => {
  const root = createProject({
    'node_modules/browserslist-config-a/package.json': JSON.stringify({ name: 'browserslist-config-a' }),
    'node_modules/browserslist-config-a/index.js':
      "module.exports = ['Chrome >= 100', 'extends browserslist-config-b'];",
    'node_modules/browserslist-config-b/package.json': JSON.stringify({ name: 'browserslist-config-b' }),
    'node_modules/browserslist-config-b/index.js': "module.exports = ['extends browserslist-config-a'];",
    '.browserslistrc': 'extends browserslist-config-a\n',
    'a.js': '',
  });
  assert.throws(
    () => resolveTargets(join(root, 'a.js')),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.code === 'COMPATGATE_TARGETS' &&
      error.message.startsWith(`${join(root, '.browserslistrc')}: extends browserslist-config-a: `) &&
      error.message.includes('circular'),
  );
});

test('a query that selects no browser is a targets error that names the config', () => {
  const root = createProject({ '.browserslistrc': 'Chrome > 1000\n', 'a.js': '' });
  assert.throws(
    () => resolveTargets(join(root, 'a.js')),
    (error: unknown) =>
      error instanceof TargetsConfigError &&
      error.message === `${join(root, '.browserslistrc')}: Chrome > 1000: selects no browser`,
  );
});
