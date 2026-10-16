import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';

import plugin from '../src/index.ts';

const TARGETS = 'Chrome >= 97';

function lint(compatgate: unknown, code = 'structuredClone(1);'): Linter.LintMessage[] {
  return new Linter({ cwd: '/p' }).verify(
    code,
    { plugins: { compatgate: plugin }, rules: { 'compatgate/exact': 'error' }, settings: { compatgate } },
    '/p/a.js',
  );
}

test('the rules take no options', () => {
  for (const rule of Object.values(plugin.rules)) {
    assert.deepEqual(rule.meta.schema, []);
  }
});

test('an unknown key of the settings is an error that lists the known keys', () => {
  assert.throws(
    () => lint({ targets: TARGETS, allow: [], target: 'Chrome >= 97' }),
    (error: Error & { code?: string }) =>
      error.name === 'OptionsError' &&
      error.code === 'COMPATGATE_OPTIONS' &&
      /settings\.compatgate: unknown key "target"\. Known keys: targets, defaultTargets, allow, extends, syntax/.test(
        error.message,
      ),
  );
});

test('the settings do not accept __proto__', () => {
  assert.throws(
    () => lint(JSON.parse('{ "__proto__": { "targets": "Chrome >= 97" } }')),
    /settings\.compatgate: unknown key "__proto__"\. Known keys: targets, defaultTargets, allow, extends, syntax/,
  );
});

test('a value of a wrong type is an error that names the key', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ targets: ['Chrome >= 97'] }, /settings\.compatgate\.targets: expected a string/],
    [{ defaultTargets: 1 }, /settings\.compatgate\.defaultTargets: expected a string/],
    [{ allow: 'api.structuredClone' }, /settings\.compatgate\.allow: expected an array/],
    [{ extends: '@company/allow' }, /settings\.compatgate\.extends: expected an array of strings/],
    [{ extends: [1] }, /settings\.compatgate\.extends: expected an array of strings/],
    [{ syntax: 'yes' }, /settings\.compatgate\.syntax: expected a boolean/],
  ];
  for (const [settings, message] of cases) {
    assert.throws(
      () => lint({ targets: TARGETS, allow: [], ...settings }),
      (error: Error & { code?: string }) =>
        error.name === 'OptionsError' && error.code === 'COMPATGATE_OPTIONS' && message.test(error.message),
    );
  }
  // ESLint adds the rule and the file to the message.
  assert.throws(() => lint('Chrome >= 97'), /^OptionsError: .*settings\.compatgate: expected an object/);
  assert.throws(
    () => lint({ targets: TARGETS, allow: ['api.structuredClone', 1] }),
    /^OptionsError: .*settings\.compatgate\.allow\[1\]: expected a feature id or an object/,
  );
});

/** The messages of an error of the configs: one message of the exact rule at the start of the file. */
function configErrors(messages: Linter.LintMessage[]): string[] {
  for (const message of messages) {
    assert.deepEqual([message.ruleId, message.line, message.column], ['compatgate/exact', 1, 1], message.message);
  }
  return messages.map(message => message.message);
}

test('an allow entry of a wrong shape is the error of the core', () => {
  const [message, ...rest] = configErrors(
    lint({ targets: TARGETS, allow: [{ feature: 'api.structuredClone', reason: 'polyfill' }] }),
  );
  assert.deepEqual(rest, []);
  assert.match(
    message ?? '',
    /^settings\.compatgate\.allow\[0\]: unknown key "reason"\. Known keys: feature, packages, files, baseDir\. Write the reason as a comment/,
  );
});

test('an allow entry may not set origin: compatgate sets it', () => {
  // An inherited entry would be no own entry: an unknown id of it would be only a warning.
  const messages = configErrors(
    lint({ targets: TARGETS, allow: [{ feature: 'api.structuredClone', origin: 'inherited' }] }),
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /^settings\.compatgate\.allow\[0\]: unknown key "origin"/);
});

test('an unknown feature id in allow is a message of the exact rule, and the file is still checked', () => {
  const messages = lint(
    { targets: TARGETS, allow: ['api.structuredClone', 'api.DoesNotExist', 'api.AlsoMissing'] },
    'structuredClone(1); Object.groupBy(a, f);',
  );
  assert.deepEqual(configErrors(messages.slice(0, 2)), [
    'settings.compatgate.allow[1]: unknown feature "api.DoesNotExist". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
    'settings.compatgate.allow[2]: unknown feature "api.AlsoMissing". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
  ]);
  assert.deepEqual(
    messages.slice(2).map(message => message.message.split(' ')[0]),
    ['javascript.builtins.Object.groupBy'],
  );
});

test('an entry that became native is no error in the linter', () => {
  assert.equal(lint({ targets: TARGETS, allow: ['javascript.builtins.Array.at'] }).length, 1);
});

test('an invalid query is the error of the core', () => {
  const messages = configErrors(lint({ targets: 'Chrome >= nonsense', allow: [] }));
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? '', /^settings\.compatgate\.targets: Chrome >= nonsense: /);
});

test('the heuristic and partial rules stay silent on an error of the configs', () => {
  const messages = new Linter({ cwd: '/p' }).verify(
    'structuredClone(1); x.toSorted(); new BarcodeDetector();',
    {
      plugins: { compatgate: plugin },
      rules: { 'compatgate/heuristic': 'warn', 'compatgate/partial': 'warn' },
      settings: { compatgate: { targets: 'Chrome >= nonsense', allow: [] } },
    },
    '/p/a.js',
  );
  assert.deepEqual(messages, []);
});
