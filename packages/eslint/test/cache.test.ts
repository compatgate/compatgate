import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { Linter } from 'eslint';

import plugin from '../src/index.ts';
import { core } from '../src/rule.ts';

const ALL_RULES: Linter.RulesRecord = {
  'compatgate/exact': 'error',
  'compatgate/heuristic': 'warn',
  'compatgate/partial': 'warn',
};
const config = (compatgate: Record<string, unknown> = {}): Linter.Config => ({
  plugins: { compatgate: plugin },
  rules: ALL_RULES,
  settings: { compatgate: { targets: 'Chrome >= 97', allow: [], ...compatgate } },
});
const SOURCE = 'structuredClone(1); x.toSorted(); new BarcodeDetector();';

afterEach(() => mock.restoreAll());

test('three rules on one file call the core once', () => {
  const check = mock.method(core, 'createResolver');
  const messages = new Linter({ cwd: '/p' }).verify(SOURCE, config(), '/p/a.js');
  assert.deepEqual(
    messages.map(message => message.ruleId),
    ['compatgate/exact', 'compatgate/heuristic', 'compatgate/partial'],
  );
  assert.equal(check.mock.callCount(), 1);
});

test('a second lint of the same file calls the core again', () => {
  // An IDE lints a file again after an edit of compatgate.jsonc, with the same text.
  const check = mock.method(core, 'createResolver');
  const linter = new Linter({ cwd: '/p' });
  linter.verify(SOURCE, config(), '/p/a.js');
  linter.verify(SOURCE, config(), '/p/a.js');
  assert.equal(check.mock.callCount(), 2);
});

test('other settings or another text call the core again', () => {
  const check = mock.method(core, 'createResolver');
  const linter = new Linter({ cwd: '/p' });
  linter.verify(SOURCE, config(), '/p/a.js');
  assert.equal(linter.verify(SOURCE, config({ allow: ['api.structuredClone'] }), '/p/a.js').length, 2);
  assert.equal(linter.verify(`${SOURCE}\n`, config(), '/p/a.js').length, 3);
  assert.equal(check.mock.callCount(), 3);
});

test('a rule does not take the cached result of other settings', () => {
  const linter = new Linter({ cwd: '/p' });
  const only = (rule: string, compatgate: Record<string, unknown>): Linter.Config => ({
    plugins: { compatgate: plugin },
    rules: { [`compatgate/${rule}`]: 'error' },
    settings: { compatgate: { targets: 'Chrome >= 97', ...compatgate } },
  });
  // The heuristic rule caches a result without structuredClone; the exact rule has not taken it yet.
  assert.equal(linter.verify(SOURCE, only('heuristic', { allow: ['api.structuredClone'] }), '/p/a.js').length, 1);
  assert.equal(linter.verify(SOURCE, only('exact', { allow: [] }), '/p/a.js').length, 1);
});

test('files of two configs in mixed order share two checkers', () => {
  const { createResolver } = core;
  const checkers = new Set<unknown>();
  const create = mock.method(core, 'createResolver', (options: Parameters<typeof createResolver>[0]) => {
    const resolver = createResolver(options);
    return {
      resolve(filename: string) {
        const configuration = resolver.resolve(filename);
        checkers.add(configuration.checker);
        return configuration;
      },
    };
  });
  const linter = new Linter({ cwd: '/p' });
  const configs = ['Chrome >= 91', 'Chrome >= 92'].map(targets => config({ targets, allow: ['api.structuredClone'] }));
  for (let index = 0; index < 8; index += 1) {
    linter.verify(SOURCE, configs[index % 2]!, `/p/${index}.js`);
  }
  assert.equal(create.mock.callCount(), 8);
  assert.equal(checkers.size, 2);
});
