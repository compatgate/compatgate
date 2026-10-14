import { after, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ESLint, Linter } from 'eslint';

import { clearCaches } from '@compatgate/core';
import plugin from '../src/index.ts';

const RULES: Linter.RulesRecord = {
  'compatgate/exact': 'error',
  'compatgate/heuristic': 'warn',
  'compatgate/partial': 'warn',
};

beforeEach(() => clearCaches());

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'compatgate-eslint-'));
  roots.push(root);
  return root;
}

/** A project with `.browserslistrc` and `compatgate.jsonc` that allows structuredClone in `src/allowed`. */
function project(): string {
  const root = tempRoot();
  mkdirSync(join(root, 'src/allowed'), { recursive: true });
  writeFileSync(join(root, '.browserslistrc'), 'Chrome >= 97\n');
  writeFileSync(
    join(root, 'compatgate.jsonc'),
    '{ "allow": [{ "feature": "api.structuredClone", "files": ["src/allowed/**"] }] }',
  );
  return root;
}

function features(messages: Linter.LintMessage[]): string[] {
  return messages.map(message => message.message.split(' ')[0] as string);
}

test('the rules find the browserslist config and compatgate.jsonc above the file', () => {
  const root = project();
  const linter = new Linter({ cwd: root });
  const config = { plugins: { compatgate: plugin }, rules: RULES };
  assert.deepEqual(features(linter.verify('structuredClone(1);', config, join(root, 'src/a.js'))), [
    'api.structuredClone',
  ]);
  assert.deepEqual(linter.verify('structuredClone(1);', config, join(root, 'src/allowed/a.js')), []);
});

test('two files with the same text get the findings of their own allow entries', () => {
  const root = project();
  const linter = new Linter({ cwd: root });
  const config = { plugins: { compatgate: plugin }, rules: RULES };
  const source = 'structuredClone(1);';
  for (let round = 0; round < 2; round += 1) {
    assert.equal(linter.verify(source, config, join(root, 'src/a.js')).length, 1);
    assert.equal(linter.verify(source, config, join(root, 'src/allowed/a.js')).length, 0);
  }
});

test('a rule does not take the cached result of another file with the same text', () => {
  const root = project();
  const linter = new Linter({ cwd: root });
  const only = (rule: string): Linter.Config => ({
    plugins: { compatgate: plugin },
    rules: { [`compatgate/${rule}`]: 'error' },
  });
  const source = 'structuredClone(1);';
  // The heuristic rule caches the result of the allowed file; the exact rule has not taken it yet.
  assert.equal(linter.verify(source, only('heuristic'), join(root, 'src/allowed/a.js')).length, 0);
  assert.equal(linter.verify(source, only('exact'), join(root, 'src/a.js')).length, 1);
});

test('a relative name and <input> resolve against the cwd of the linter', () => {
  const root = project();
  const linter = new Linter({ cwd: root });
  const config = { plugins: { compatgate: plugin }, rules: RULES };
  // `src/allowed/a.js` matches the `files` of compatgate.jsonc only when it resolves against the cwd.
  assert.equal(linter.verify('structuredClone(1);', config, 'src/allowed/a.js').length, 0);
  assert.equal(linter.verify('structuredClone(1);', config, 'src/a.js').length, 1);
  // Text without a file name: the configs of the cwd apply, and the text is JavaScript.
  assert.deepEqual(features(linter.verify('structuredClone(1);', config)), ['api.structuredClone']);
});

test('text from stdin takes the configs of the cwd', async () => {
  const root = project();
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: { plugins: { compatgate: plugin }, rules: RULES },
  });
  const [result] = await eslint.lintText('structuredClone(1);');
  assert.deepEqual(features(result!.messages), ['api.structuredClone']);
});

test('without configs a file outside the project takes defaultTargets', () => {
  const root = tempRoot();
  const linter = new Linter({ cwd: root });
  const config = (defaultTargets?: string) => ({
    plugins: { compatgate: plugin },
    rules: RULES,
    settings: { compatgate: defaultTargets ? { defaultTargets } : {} },
  });
  assert.equal(linter.verify('structuredClone(1);', config('Chrome >= 97')).length, 1);
  assert.equal(linter.verify('structuredClone(1);', config('Chrome >= 120')).length, 0);
});

test('the allow settings resolve against the cwd of the linter', () => {
  const root = project();
  const linter = new Linter({ cwd: root });
  const config = (compatgate: Record<string, unknown>) => ({
    plugins: { compatgate: plugin },
    rules: RULES,
    settings: { compatgate },
  });
  const file = join(root, 'src/allowed/a.js');
  assert.equal(
    linter.verify(
      'structuredClone(1);',
      config({ allow: [{ feature: 'api.structuredClone', files: ['src/**'] }] }),
      file,
    ).length,
    0,
  );
  assert.equal(
    linter.verify('structuredClone(1);', config({ allow: [], extends: ['./compatgate.jsonc'] }), file).length,
    0,
  );
});

test('a block of a processor takes the configs of the physical file and the parser of its own name', () => {
  const root = project();
  const markdown: ESLint.Plugin = {
    processors: {
      markdown: {
        preprocess: (text: string) => [{ text, filename: '0.js' }],
        postprocess: (messages: Linter.LintMessage[][]) => messages.flat(),
      },
    },
  };
  const linter = new Linter({ cwd: root });
  const config: Linter.Config[] = [
    { files: ['**/*.md'], plugins: { markdown }, processor: 'markdown/markdown' },
    { files: ['**/*.js'], plugins: { compatgate: plugin }, rules: RULES },
  ];
  assert.deepEqual(features(linter.verify('structuredClone(1);', config, join(root, 'src/README.md'))), [
    'api.structuredClone',
  ]);
  assert.deepEqual(linter.verify('structuredClone(1);', config, join(root, 'src/allowed/README.md')), []);
  // `files` match the physical file: a pattern for Markdown files covers their code blocks.
  writeFileSync(
    join(root, 'compatgate.jsonc'),
    '{ "allow": [{ "feature": "api.structuredClone", "files": ["**/*.md"] }] }',
  );
  // The core checks the configs at most once in 250 ms.
  clearCaches();
  assert.deepEqual(linter.verify('structuredClone(1);', config, join(root, 'src/README.md')), []);
  assert.equal(linter.verify('structuredClone(1);', config[1]!, join(root, 'src/a.js')).length, 1);
  // The name of the block matches no pattern.
  writeFileSync(
    join(root, 'compatgate.jsonc'),
    '{ "allow": [{ "feature": "api.structuredClone", "files": ["**/*.md/**"] }] }',
  );
  clearCaches();
  assert.equal(linter.verify('structuredClone(1);', config, join(root, 'src/README.md')).length, 1);
});

test('a file that the core does not parse is skipped', () => {
  const linter = new Linter({ cwd: '/p' });
  const config = [
    {
      files: ['**/*.vue'],
      plugins: { compatgate: plugin },
      rules: RULES,
      settings: { compatgate: { targets: 'Chrome >= 97', allow: [] } },
    },
  ];
  assert.deepEqual(linter.verify('structuredClone(1);', config, '/p/App.vue'), []);
});

test('a source that the core cannot parse gives no messages', () => {
  // espree takes JSX, but the core parses a `.ts` file as TypeScript without JSX.
  const linter = new Linter({ cwd: '/p' });
  const messages = linter.verify(
    'const a = <div>{structuredClone(1)}</div>;',
    {
      files: ['**/*.ts'],
      plugins: { compatgate: plugin },
      rules: RULES,
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      settings: { compatgate: { targets: 'Chrome >= 97', allow: [] } },
    },
    '/p/a.ts',
  );
  assert.deepEqual(messages, []);
});

test('an unknown feature id gets the closest known id, in the same words as in the bundler', () => {
  const root = project();
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": ["./base.jsonc"], "allow": ["api.Fetch"] }');
  writeFileSync(join(root, 'base.jsonc'), '{ "allow": ["api.URL.canParse"] }');
  const warnings: string[] = [];
  const emit = mock.method(process, 'emitWarning', (message: string) => warnings.push(message));
  let messages: Linter.LintMessage[];
  try {
    messages = new Linter({ cwd: root }).verify(
      'structuredClone(1);',
      { plugins: { compatgate: plugin }, rules: RULES },
      join(root, 'src/a.js'),
    );
  } finally {
    emit.mock.restore();
  }
  assert.deepEqual(warnings, [
    'compatgate: base.jsonc, allow[0]: unknown feature "api.URL.canParse". compatgate ignores the entry. ' +
      'Did you mean "api.URL.canParse_static"?',
  ]);
  assert.equal(
    messages.find(message => message.message.startsWith('compatgate.jsonc'))?.message,
    'compatgate.jsonc, allow[0]: unknown feature "api.Fetch". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone". ' +
      'Did you mean "api.fetch"?',
  );
});

test('an unknown feature id names the config that holds it', () => {
  const root = project();
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": ["./base.jsonc"], "allow": ["api.Typo"] }');
  writeFileSync(join(root, 'base.jsonc'), '{ "allow": ["api.BaseTypo"] }');
  writeFileSync(join(root, 'clean.jsonc'), '{ "allow": [] }');
  const linter = new Linter({ cwd: root });
  const lint = (compatgate: Record<string, unknown>) =>
    linter.verify(
      'structuredClone(1);',
      { plugins: { compatgate: plugin }, rules: RULES, settings: { compatgate } },
      join(root, 'src/a.js'),
    );
  // An unknown id of a base is a warning of the process, once per list: a shared list may be newer than the core.
  const warnings: string[] = [];
  const emit = mock.method(process, 'emitWarning', (message: string) => warnings.push(message));
  try {
    writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": ["./base.jsonc"] }');
    assert.equal(lint({ extends: ['./clean.jsonc'] }).length, 1);
    assert.equal(lint({ extends: ['./clean.jsonc'] }).length, 1);
  } finally {
    emit.mock.restore();
  }
  assert.deepEqual(warnings, [
    'compatgate: base.jsonc, allow[0]: unknown feature "api.BaseTypo". compatgate ignores the entry.',
  ]);
  // An unknown id of the project is a message of the exact rule at the start of each file.
  const typo = {
    ruleId: 'compatgate/exact',
    line: 1,
    column: 1,
    message:
      'compatgate.jsonc, allow[0]: unknown feature "api.Typo". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".',
  };
  // The finding of structuredClone follows: an unknown id hides nothing.
  const configMessages = (messages: Linter.LintMessage[]) =>
    messages
      .filter(message => message.message.startsWith('compatgate.jsonc'))
      .map(({ ruleId, line, column, message }) => ({ ruleId, line, column, message }));
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": ["./base.jsonc"], "allow": ["api.Typo"] }');
  // The core checks the configs at most once in 250 ms.
  clearCaches();
  assert.deepEqual(configMessages(lint({})), [typo]);
  writeFileSync(join(root, 'base.jsonc'), '{ "allow": [] }');
  clearCaches();
  assert.deepEqual(configMessages(lint({})), [typo]);
});

test('a broken config is one message of the exact rule in each file; other rules and files are checked', async () => {
  const root = project();
  mkdirSync(join(root, 'other'), { recursive: true });
  writeFileSync(join(root, 'src/a.js'), 'debugger;\nstructuredClone(1);\n');
  writeFileSync(join(root, 'src/b.js'), 'x.toSorted();\n');
  writeFileSync(join(root, 'other/c.js'), 'structuredClone(1);\n');
  writeFileSync(join(root, 'other/compatgate.jsonc'), '{ "allow": [] }');
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "allow": [');
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: { plugins: { compatgate: plugin }, rules: { ...RULES, 'no-debugger': 'error' } },
  });
  const lint = async () =>
    Object.fromEntries(
      (await eslint.lintFiles(['src', 'other'])).map(result => [
        result.filePath.slice(root.length + 1),
        result.messages.map(({ ruleId, line, column, message }) => `${ruleId} ${line}:${column} ${message}`),
      ]),
    );
  const broken = `compatgate/exact 1:1 ${join(root, 'compatgate.jsonc')}: CloseBracketExpected at offset 12`;
  assert.deepEqual(await lint(), {
    'src/a.js': [broken, "no-debugger 1:1 Unexpected 'debugger' statement."],
    'src/b.js': [broken],
    'other/c.js': [
      'compatgate/exact 1:1 api.structuredClone is not supported in Chrome 97 (since 98). Check the feature in code, ' +
        'or add "api.structuredClone" to other/compatgate.jsonc.',
    ],
  });
  // A fix of the config shows in the next lint.
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "allow": [] }');
  const fixed = await lint();
  assert.deepEqual(fixed['src/b.js'], [
    'compatgate/heuristic 1:3 javascript.builtins.Array.toSorted is not supported in Chrome 97 (since 110). The method ' +
      'is found by its name, so it may also be javascript.builtins.TypedArray.toSorted. Check the feature in code, or ' +
      'add "javascript.builtins.Array.toSorted" to compatgate.jsonc.',
  ]);
});

test('the advice of a finding names the compatgate.jsonc of the file', () => {
  const root = project();
  mkdirSync(join(root, 'src/lib'), { recursive: true });
  writeFileSync(join(root, 'src/lib/compatgate.jsonc'), '{ "allow": [] }');
  const linter = new Linter({ cwd: root });
  const advice = (file: string) =>
    linter
      .verify('structuredClone(1);', { plugins: { compatgate: plugin }, rules: RULES }, join(root, file))
      .map(message => message.message.replace(/^.*, or /, ''));
  assert.deepEqual(advice('src/a.js'), ['add "api.structuredClone" to compatgate.jsonc.']);
  assert.deepEqual(advice('src/lib/deep/a.js'), ['add "api.structuredClone" to src/lib/compatgate.jsonc.']);
});

test('a project that lies inside node_modules keeps its own configs: the cwd of the linter is its root', () => {
  const root = tempRoot();
  const proj = join(root, 'node_modules/proj');
  mkdirSync(join(proj, 'src'), { recursive: true });
  writeFileSync(join(root, '.browserslistrc'), 'Chrome >= 130\n');
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "allow": ["javascript.builtins.Object.groupBy"] }');
  writeFileSync(join(proj, '.browserslistrc'), 'Chrome >= 97\n');
  writeFileSync(join(proj, 'compatgate.jsonc'), '{ "allow": ["api.structuredClone"] }');
  const linter = new Linter({ cwd: proj });
  const config = { plugins: { compatgate: plugin }, rules: RULES };
  const source = 'structuredClone({}); Object.groupBy([], String);';
  assert.deepEqual(features(linter.verify(source, config, join(proj, 'src/a.js'))), [
    'javascript.builtins.Object.groupBy',
  ]);
});
