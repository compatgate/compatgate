import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import type { ESLint } from 'eslint';

import plugin from '../src/index.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the plugin has a name, a version and three rules', () => {
  assert.deepEqual(plugin.meta, { name: '@compatgate/eslint', version });
  assert.deepEqual(Object.keys(plugin.rules), ['exact', 'heuristic', 'partial']);
  for (const [name, rule] of Object.entries(plugin.rules)) {
    assert.equal(rule.meta.type, 'problem');
    assert.equal(typeof rule.meta.docs.description, 'string');
    // The section of the rule in the README of the package on npm.
    assert.equal(rule.meta.docs.url, `https://www.npmjs.com/package/@compatgate/eslint#${name}`);
  }
});

test('each rule has a section of its own in the README, which its url names', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const name of Object.keys(plugin.rules)) {
    // npm makes the anchor `#exact` of the heading `` ### `exact` ``.
    assert.ok(readme.split('\n').includes(`### \`${name}\``), name);
  }
});

test('the plugin is an ESLint plugin', () => {
  // A type check: the test fails `pnpm typecheck` when the shapes drift apart.
  const eslintPlugin: ESLint.Plugin = plugin;
  assert.ok(eslintPlugin);
});

test('the recommended config makes exact an error, heuristic and partial warnings', () => {
  const { recommended } = plugin.configs;
  assert.equal(recommended.plugins.compatgate, plugin);
  assert.deepEqual(recommended.rules, {
    'compatgate/exact': 'error',
    'compatgate/heuristic': 'warn',
    'compatgate/partial': 'warn',
  });
  const messages = new Linter({ cwd: '/p' }).verify(
    'structuredClone(1); x.toSorted(); new BarcodeDetector();',
    [recommended, { settings: { compatgate: { targets: 'Chrome >= 97', allow: [] } } }],
    '/p/a.js',
  );
  assert.deepEqual(
    messages.map(message => [message.ruleId, message.severity]),
    [
      ['compatgate/exact', 2],
      ['compatgate/heuristic', 1],
      ['compatgate/partial', 1],
    ],
  );
});

test('the published entry point exports the plugin', async () => {
  // Imports the package by its name, so Node resolves "exports" to the built dist, as consumers do.
  const module = await import('@compatgate/eslint');
  const published = module.default;
  assert.deepEqual(Object.keys(published.rules), ['exact', 'heuristic', 'partial']);
  // The error of a wrong `settings.compatgate`: the class of the core, as the bundler exports it too.
  assert.equal(module.OptionsError, (await import('@compatgate/core')).OptionsError);
  assert.equal('SettingsError' in module, false);
  assert.equal(published.meta.name, '@compatgate/eslint');
  const path = createRequire(import.meta.url).resolve('@compatgate/eslint/package.json');
  assert.equal(createRequire(import.meta.url)(path).name, '@compatgate/eslint');
});

test('the published tarball holds dist and no build info', () => {
  const [report] = JSON.parse(
    // npm is a batch file on Windows: only a shell runs it.
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: packageDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  );
  const files: string[] = report.files.map((file: { path: string }) => file.path);
  for (const expected of ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts', 'dist/rule.js']) {
    assert.ok(files.includes(expected), `${expected} is missing from ${files.join(', ')}`);
  }
  assert.deepEqual(
    files.filter(file => file.endsWith('.tsbuildinfo')),
    [],
  );
});
