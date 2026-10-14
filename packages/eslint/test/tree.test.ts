// The rules on a tree of a real project: nested directories, configs at a few levels, `extends` in a
// compatgate.jsonc and a long base list in the settings, as a build tool passes the features of its polyfills.
// Each directory with configs takes one computation of its configuration, whatever the number of files and the length
// of the list; ESLint and oxlint give the same findings.

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearCaches } from '@compatgate/core';
import { Linter } from 'eslint';

// The counters are internal to the core. The plugin loads the core through the link of the workspace, and Node
// resolves the link to this same file, so the plugin and the test share one module. A test that read another copy
// would see no computation at all and fail.
import { counters } from '../../core/dist/configuration.js';
import plugin from '../src/index.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const oxlintBin = join(packageDir, 'node_modules/.bin/oxlint');
const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

// A base list as a build tool ships it: the features that core-js closes.
const POLYFILLS = [
  ...['toSorted', 'toReversed', 'toSpliced', 'with', 'findLast', 'findLastIndex', 'fromAsync', 'at', 'flat'].map(
    name => `javascript.builtins.Array.${name}`,
  ),
  'javascript.builtins.Array.flatMap',
  ...['groupBy', 'hasOwn', 'fromEntries'].map(name => `javascript.builtins.Object.${name}`),
  'javascript.builtins.Map.groupBy',
  ...['withResolvers', 'allSettled', 'any'].map(name => `javascript.builtins.Promise.${name}`),
  ...['replaceAll', 'at', 'isWellFormed', 'toWellFormed'].map(name => `javascript.builtins.String.${name}`),
  ...['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom'].map(
    name => `javascript.builtins.Set.${name}`,
  ),
  ...['from', 'toArray', 'map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'some', 'every', 'find', 'forEach'].map(
    name => `javascript.builtins.Iterator.${name}`,
  ),
  'api.structuredClone',
  'api.queueMicrotask',
  'api.URLSearchParams.size',
  'api.URL.canParse_static',
  'javascript.builtins.Error.cause',
];

// One text in every file: each line is a finding in some directories and none in others.
const SOURCE = [
  'export const copy = structuredClone({});', // the base list of the settings: no finding anywhere
  'export const words = new Intl.Segmenter();', // the root compatgate.jsonc
  "export const share = () => navigator.share({ url: '/' });", // the compatgate.jsonc of apps/web, through extends
  'export const ref = new WeakRef({});', // Chrome 84: a finding in apps/web/src/legacy only
  '',
].join('\n');

// The directories of the files, from the root. Each has three files.
const DIRECTORIES = [
  'src',
  'src/a',
  'src/a/b',
  'src/a/b/c',
  'src/d',
  'src/d/e',
  'apps/web/src',
  'apps/web/src/a',
  'apps/web/src/a/b',
  'apps/web/src/a/b/c',
  'apps/web/src/d/e/f',
  'apps/web/src/legacy',
  'apps/web/src/legacy/a',
  'apps/web/src/legacy/a/b',
  'apps/admin/src',
  'apps/admin/src/a',
  'apps/admin/src/a/b',
  'packages/ui/src',
  'packages/ui/src/a',
  'packages/ui/src/a/b',
];
// The directories with configs that the files reach: the root, apps/web, apps/web/src/legacy and packages/ui, whose
// package.json without browserslist may hold targets too.
const CONFIG_DIRECTORIES = 4;

/** The findings of a file, by the start of its directory. */
function expectedFeatures(directory: string): string[] {
  if (directory.startsWith('apps/web/src/legacy')) {
    return ['javascript.builtins.Intl.Segmenter', 'javascript.builtins.WeakRef'];
  }
  if (directory.startsWith('apps/web')) {
    // The closest compatgate.jsonc replaces the one of the root: its Intl.Segmenter entry is gone.
    return ['javascript.builtins.Intl.Segmenter'];
  }
  return ['api.Navigator.share'];
}

const PROJECT: Record<string, string> = {
  '.browserslistrc': `${TARGETS}\n`,
  'tool-base.jsonc': JSON.stringify({ allow: POLYFILLS }, null, 2),
  'config/company.jsonc': '{ "allow": ["javascript.builtins.Intl.Segmenter"] }',
  'compatgate.jsonc': '{ "extends": "./config/company.jsonc", "allow": [] }',
  'config/web.jsonc': '{ "allow": ["api.Navigator.share"] }',
  'apps/web/compatgate.jsonc': '{ "extends": "../../config/web.jsonc", "allow": [] }',
  'apps/web/src/legacy/.browserslistrc': 'Chrome >= 80\n',
  'packages/ui/package.json': '{ "name": "ui", "private": true }',
};

const SETTINGS = { extends: ['./tool-base.jsonc'] };

let root: string;
const files: string[] = [];

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compatgate-tree-')));
  for (const [name, content] of Object.entries(PROJECT)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  for (const directory of DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true });
    for (const name of ['one.js', 'two.js', 'three.js']) {
      writeFileSync(join(root, directory, name), SOURCE);
      files.push(`${directory}/${name}`);
    }
  }
  // oxlint resolves `jsPlugins` like an import: the project installs the package by its name.
  mkdirSync(join(root, 'node_modules/@compatgate'), { recursive: true });
  symlinkSync(packageDir, join(root, 'node_modules/@compatgate/eslint'), 'dir');
});

after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => clearCaches());

const expected = () =>
  files.flatMap(file => expectedFeatures(dirname(file)).map(feature => `${file} ${feature}`)).sort();

function eslint(linter: Linter): string[] {
  const config: Linter.Config = {
    plugins: { compatgate: plugin },
    rules: { 'compatgate/exact': 'error', 'compatgate/heuristic': 'warn', 'compatgate/partial': 'warn' },
    settings: { compatgate: SETTINGS },
  };
  return files
    .flatMap(file =>
      linter.verify(readFileSync(join(root, file), 'utf8'), config, join(root, file)).map(message => {
        assert.ok(message.ruleId, `${file}: ${message.message}`);
        return `${file} ${message.message.split(' ')[0]}`;
      }),
    )
    .sort();
}

test('ESLint gives each directory of the tree the findings of its closest configs', () => {
  assert.deepEqual(eslint(new Linter({ cwd: root })), expected());
});

test('each directory with configs takes one computation of its configuration', () => {
  const linter = new Linter({ cwd: root });
  const before = counters.computations;
  eslint(linter);
  assert.equal(files.length, DIRECTORIES.length * 3);
  assert.equal(counters.computations - before, CONFIG_DIRECTORIES);
  // A second lint of the tree finds every config unchanged.
  eslint(linter);
  assert.equal(counters.computations - before, CONFIG_DIRECTORIES);
});

test('oxlint gives the tree the findings of ESLint', () => {
  const config = join(root, 'oxlintrc.json');
  writeFileSync(
    config,
    JSON.stringify({
      plugins: [],
      categories: { correctness: 'off' },
      jsPlugins: ['@compatgate/eslint'],
      rules: {
        '@compatgate/eslint/exact': 'error',
        '@compatgate/eslint/heuristic': 'warn',
        '@compatgate/eslint/partial': 'warn',
      },
      settings: { compatgate: SETTINGS },
    }),
  );
  const run = spawnSync(oxlintBin, ['-c', config, '--format', 'json', 'src', 'apps', 'packages'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(run.stdout.startsWith('{'), `oxlint failed: ${run.stdout}\n${run.stderr}`);
  const diagnostics: { message: string; code: string; filename: string }[] = JSON.parse(run.stdout).diagnostics;
  const found = diagnostics
    .map(diagnostic => {
      assert.match(diagnostic.code, /compatgate/, diagnostic.message);
      const file = relative(root, join(root, diagnostic.filename)).replaceAll('\\', '/');
      return `${file} ${diagnostic.message.split(' ')[0]}`;
    })
    .sort();
  assert.deepEqual(found, expected());
});
