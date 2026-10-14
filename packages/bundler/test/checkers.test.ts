import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createResolver, type AllowEntryInput, type Configuration } from '@compatgate/core';

import { CheckerRegistry, checkFile } from '../src/checkers.ts';
import { TARGETS } from './helpers.ts';

const SEGMENTER = 'javascript.builtins.Intl.Segmenter';
const CODE = "new Intl.Segmenter('en');\n";

/** The configuration of the core for inline entries of the project `/p`. */
function resolved(targets: string, ...allow: (string | AllowEntryInput)[]): Configuration {
  return createResolver({ targets, allow, baseDir: '/p' }).resolve('/p/src/a.ts');
}

test('one configuration serves every module with the same checker of the core', () => {
  const registry = new CheckerRegistry();
  const first = registry.configuration(resolved(TARGETS, SEGMENTER));
  assert.equal(registry.configuration(resolved(TARGETS, SEGMENTER)), first);
  assert.notEqual(registry.configuration(resolved(TARGETS, 'api.fetch')), first);
  assert.notEqual(registry.configuration(resolved('Chrome >= 97', SEGMENTER)), first);
  assert.equal(first.entries, resolved(TARGETS, SEGMENTER).entries);
});

test('a configuration checks a module and keeps no record of it', () => {
  const registry = new CheckerRegistry();
  const configuration = registry.configuration(resolved(TARGETS, 'api.fetch', SEGMENTER));
  const result = checkFile(configuration, CODE, { path: '/p/src/a.ts' });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.suppressed, [{ index: 1, kind: 'builtin' }]);
  // The records of the modules live apart, in `ModuleRecords`: a module from a cache keeps its own.
  assert.ok(!('usedEntries' in configuration));
  assert.ok(!('modules' in configuration));
});

test('a new build drops the configurations that the last build did not take', () => {
  const registry = new CheckerRegistry();
  const used = registry.configuration(resolved(TARGETS, SEGMENTER));
  registry.configuration(resolved('Chrome >= 97'));
  assert.equal(registry.size, 2);

  registry.startBuild();
  assert.equal(registry.configuration(resolved(TARGETS, SEGMENTER)), used);
  registry.startBuild();
  assert.equal(registry.size, 1);
  assert.equal(registry.configuration(resolved(TARGETS, SEGMENTER)), used);
});

test('a configuration keeps its messages until a build drops it', () => {
  const registry = new CheckerRegistry();
  const configuration = registry.configuration(resolved(TARGETS, SEGMENTER));
  const messages = { errors: ['e'], warnings: [] };
  assert.equal(
    registry.messages(configuration, () => messages),
    messages,
  );
  assert.equal(registry.messages(registry.configuration(resolved(TARGETS, SEGMENTER)), assert.fail), messages);
  // The messages of a configuration do not make the build take it: the second build drops it.
  registry.startBuild();
  assert.equal(registry.messages(configuration, assert.fail), messages);
  registry.startBuild();
  assert.equal(registry.size, 0);
  const again = { errors: [], warnings: [] };
  assert.equal(
    registry.messages(registry.configuration(resolved(TARGETS, SEGMENTER)), () => again),
    again,
  );
});

test('`files` of an entry match the path of a component, not the name that selects the parser', () => {
  const registry = new CheckerRegistry();
  const component = { path: '/p/src/App.vue', parseAs: '/p/src/App.vue.ts' };
  const typed = 'const s: Intl.Segmenter = new Intl.Segmenter("en");\n';
  const check = (files: string) =>
    checkFile(registry.configuration(resolved(TARGETS, { feature: SEGMENTER, files })), typed, component);

  for (const files of ['src/App.vue', 'src/*.vue', 'src/**', '**/*.vue', '/p/src/App.{vue,svelte}']) {
    const result = check(files);
    assert.equal(result.parseError, undefined);
    assert.deepEqual(result.findings, [], files);
    assert.deepEqual(result.suppressed, [{ index: 0, kind: 'builtin' }], files);
  }
  for (const files of ['src/App.vue.ts', 'src/Other.vue', 'src/*.ts', 'src']) {
    assert.equal(check(files).findings.length, 1, files);
  }
});

test('`packages` of an entry match a component of a package', () => {
  const registry = new CheckerRegistry();
  const configuration = registry.configuration(resolved(TARGETS, { feature: SEGMENTER, packages: 'ui-kit' }));
  const inPackage = checkFile(configuration, CODE, {
    path: '/p/node_modules/ui-kit/Button.vue',
    parseAs: '/p/node_modules/ui-kit/Button.vue.js',
  });
  assert.deepEqual(inPackage.findings, []);
  const outside = checkFile(configuration, CODE, { path: '/p/src/Button.vue', parseAs: '/p/src/Button.vue.js' });
  assert.equal(outside.findings.length, 1);
});

test('a component is parsed by the language of `parseAs`', () => {
  const registry = new CheckerRegistry();
  const configuration = registry.configuration(resolved(TARGETS));
  const typed = 'const n: number = 1;\n';
  assert.equal(checkFile(configuration, typed, { path: '/p/App.vue', parseAs: '/p/App.vue.ts' }).parseError, undefined);
  assert.equal(
    checkFile(configuration, typed, { path: '/p/App.vue', parseAs: '/p/App.vue.js' }).parseError?.kind,
    'syntax',
  );
});
