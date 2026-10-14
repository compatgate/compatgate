import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import typescriptParser from '@typescript-eslint/parser';

import plugin from '../src/index.ts';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const oxlintBin = join(packageDir, 'node_modules/.bin/oxlint');
const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

// Twenty files: every kind and confidence of findings, a feature check, an allowed feature, TypeScript and JSX.
const SOURCES: Record<string, string> = {
  'api.js': 'structuredClone(1);\n',
  // Columns count UTF-16 code units: a Cyrillic letter is one, an emoji two.
  'builtin.js': "const label = 'ж😀'; const s = new Intl.Segmenter();\n",
  'heuristic.js': 'export const sorted = list => list.toSorted();\n',
  'partial.js': 'new BarcodeDetector();\n',
  'syntax.js': 'const r = /(?<=a)b/;\nclass A { x = 1; }\n',
  'guard.js': "if (typeof structuredClone === 'function') structuredClone(1);\n",
  'allowed.js': 'Object.groupBy([], x => x);\n',
  'native.js': 'const last = [1].at(-1);\n',
  'many.js': 'structuredClone(1);\nconst s = new Intl.Segmenter();\nexport const f = a => a.toSorted();\n',
  'module.mjs': 'export const copy = structuredClone({});\n',
  'types.ts': 'type T = { a: number };\nexport const copy: T = structuredClone<T>({ a: 1 });\n',
  'enum.ts': 'enum Mode { A }\nexport const m = Mode.A;\nnew BarcodeDetector();\n',
  'generic.ts': 'export function sort<T>(items: T[]): T[] { return items.toSorted(); }\n',
  'class.ts': 'export class Box { value = new Intl.Segmenter(); }\n',
  'view.jsx': 'export const View = () => <div>{structuredClone(1)}</div>;\n',
  'view.tsx': 'export const View = (): JSX.Element => <p>{new Intl.Segmenter().segment("a")}</p>;\n',
  'nested/deep.js': 'export const deep = structuredClone([]);\n',
  'nested/clean.js': 'export const clean = [1, 2].map(x => x * 2);\n',
  'nested/regexp.js': 'export const re = /[\\p{L}--\\p{N}]/v;\n',
  'nested/both.ts': 'export const both = (xs: number[]) => xs.toSorted().at(0) ?? structuredClone(0);\n',
};

let root: string;

before(() => {
  // The project installs the package by its name: oxlint resolves `jsPlugins` like an import.
  root = mkdtempSync(join(tmpdir(), 'compatgate-oxlint-'));
  mkdirSync(join(root, 'node_modules/@compatgate'), { recursive: true });
  symlinkSync(packageDir, join(root, 'node_modules/@compatgate/eslint'), 'dir');
  for (const [name, source] of Object.entries(SOURCES)) {
    mkdirSync(join(root, 'src', name, '..'), { recursive: true });
    writeFileSync(join(root, 'src', name), source);
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

interface OxlintDiagnostic {
  message: string;
  code: string;
  severity: string;
  filename: string;
  labels: Array<{ span: { offset: number; length: number; line: number; column: number } }>;
}

function oxlint(config: Record<string, unknown>, paths = ['src']): OxlintDiagnostic[] {
  const run = spawnSync(oxlintBin, ['-c', writeConfig(config), '--format', 'json', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(run.stdout.startsWith('{'), `oxlint failed: ${run.stdout}\n${run.stderr}`);
  const diagnostics: OxlintDiagnostic[] = JSON.parse(run.stdout).diagnostics;
  // Rule crashes are diagnostics too. None is expected.
  const foreign = diagnostics.filter(diagnostic => !/compatgate/.test(diagnostic.code));
  assert.deepEqual(foreign, []);
  return diagnostics;
}

function oxlintConfig(compatgate: Record<string, unknown>, plugins: unknown = ['@compatgate/eslint']) {
  const prefix = Array.isArray(plugins) && typeof plugins[0] === 'string' ? '@compatgate/eslint' : 'compatgate';
  return {
    plugins: [],
    categories: { correctness: 'off' },
    jsPlugins: plugins,
    rules: { [`${prefix}/exact`]: 'error', [`${prefix}/heuristic`]: 'warn', [`${prefix}/partial`]: 'warn' },
    settings: { compatgate },
  };
}

function oxlintFindings(diagnostics: OxlintDiagnostic[]): string[] {
  return diagnostics
    .map(diagnostic => {
      const rule = /\((\w+)\)$/.exec(diagnostic.code)?.[1] ?? diagnostic.code;
      const { offset, length } = diagnostic.labels[0]!.span;
      const filename = diagnostic.filename.replaceAll('\\', '/');
      const start = position(filename, offset);
      const end = position(filename, offset + length);
      return `${filename}:${start}-${end} ${rule} ${diagnostic.message}`;
    })
    .sort();
}

/**
 * The 1-based line and column of a UTF-8 byte offset, the column in UTF-16 code units as in ESLint.
 * The JSON output of oxlint counts the columns in bytes, so its own columns differ after non-ASCII text.
 */
function position(filename: string, offset: number): string {
  const before = readFileSync(join(root, filename)).subarray(0, offset).toString('utf8');
  const lines = before.split('\n');
  return `${lines.length}:${lines.at(-1)!.length + 1}`;
}

function eslintFindings(compatgate: Record<string, unknown>): string[] {
  const linter = new Linter({ cwd: root });
  const findings: string[] = [];
  for (const name of Object.keys(SOURCES)) {
    const filename = join(root, 'src', name);
    const typescript = ['.ts', '.tsx'].includes(extname(name));
    const messages = linter.verify(
      readFileSync(filename, 'utf8'),
      {
        files: ['**/*.{js,mjs,jsx,ts,tsx}'],
        plugins: { compatgate: plugin },
        rules: { 'compatgate/exact': 'error', 'compatgate/heuristic': 'warn', 'compatgate/partial': 'warn' },
        languageOptions: {
          ...(typescript ? { parser: typescriptParser } : {}),
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        settings: { compatgate },
      },
      filename,
    );
    for (const message of messages) {
      assert.equal(message.fatal, undefined, message.message);
      assert.ok(message.ruleId, `${filename}: ${message.message}`);
      const rule = message.ruleId.split('/')[1];
      findings.push(
        `${relative(root, filename)}:${message.line}:${message.column}-${message.endLine}:${message.endColumn} ${rule} ${message.message}`,
      );
    }
  }
  return findings.sort();
}

test('oxlint loads the plugin by its name and reports the findings of ESLint', () => {
  const settings = { targets: TARGETS, allow: ['javascript.builtins.Object.groupBy'] };
  const expected = eslintFindings(settings);
  assert.ok(expected.length >= 15, expected.join('\n'));
  assert.ok(!expected.some(finding => finding.includes('Object.groupBy')));
  assert.deepEqual(oxlintFindings(oxlint(oxlintConfig(settings))), expected);
});

test('oxlint passes settings.compatgate to the rules', () => {
  const syntax = { targets: TARGETS, allow: [], syntax: true };
  const withSyntax = oxlintFindings(oxlint(oxlintConfig(syntax)));
  assert.deepEqual(withSyntax, eslintFindings(syntax));
  assert.ok(withSyntax.some(finding => finding.includes('lookbehind_assertion')));
  assert.ok(withSyntax.some(finding => finding.includes('Object.groupBy')));
  const modern = oxlintFindings(oxlint(oxlintConfig({ targets: 'Chrome >= 130', allow: [] })));
  assert.deepEqual(modern, eslintFindings({ targets: 'Chrome >= 130', allow: [] }));
  assert.ok(modern.length < withSyntax.length);
});

test('oxlint gives two files with one text the findings of their own allow scope', () => {
  // oxlint may keep one source object for all files: the result of one file must not serve the other.
  const source = 'export const copy = structuredClone({});\n';
  for (const name of ['same/allowed/a.js', 'same/other/a.js', 'same/allowed/b.js', 'same/other/b.js']) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const settings = { targets: TARGETS, allow: [{ feature: 'api.structuredClone', files: ['same/allowed/**'] }] };
  const files = oxlint(oxlintConfig(settings), ['same'])
    .map(diagnostic => diagnostic.filename.replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(files, ['same/other/a.js', 'same/other/b.js']);
});

test('oxlint takes an alias for the plugin', () => {
  const settings = { targets: TARGETS, allow: [] };
  const diagnostics = oxlint(oxlintConfig(settings, [{ name: 'compatgate', specifier: '@compatgate/eslint' }]));
  assert.ok(diagnostics.length > 0);
  assert.ok(
    diagnostics.every(diagnostic => diagnostic.code.startsWith('compatgate(')),
    diagnostics[0]?.code,
  );
});

function oxlintRun(config: Record<string, unknown>, paths: string[]): { status: number | null; findings: string[] } {
  const run = spawnSync(oxlintBin, ['-c', writeConfig(config), '--format', 'json', ...paths], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok(run.stdout.startsWith('{'), `oxlint failed: ${run.stdout}\n${run.stderr}`);
  const diagnostics: OxlintDiagnostic[] = JSON.parse(run.stdout).diagnostics;
  return { status: run.status, findings: oxlintFindings(diagnostics) };
}

test('an unknown feature id of the settings is a message of the exact rule in oxlint, as in ESLint', () => {
  const settings = { targets: TARGETS, allow: ['api.DoesNotExist'] };
  const unknown =
    'settings.compatgate.allow[0]: unknown feature "api.DoesNotExist". A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".';
  const { status, findings } = oxlintRun(oxlintConfig(settings), ['src/api.js']);
  assert.notEqual(status, 0);
  assert.deepEqual(findings, [
    `src/api.js:1:1-1:1 exact ${unknown}`,
    'src/api.js:1:1-1:16 exact api.structuredClone is not supported in Chrome 97 (since 98). Check the feature in ' +
      'code, or add "api.structuredClone" to settings.compatgate.allow.',
  ]);
  // ESLint gives a message of one position no end; oxlint gives an empty span.
  const start = (finding: string) => finding.replace(/-\S+ /, ' ');
  assert.deepEqual(
    eslintFindings(settings)
      .filter(finding => finding.startsWith('src/api.js:'))
      .map(start)
      .sort(),
    findings.map(start).sort(),
  );
});

test('a broken config is one message of the exact rule in each file in oxlint; other rules are checked', () => {
  for (const [name, source] of Object.entries({
    'broken/.browserslistrc': 'Chrome >= 97\n',
    'broken/compatgate.jsonc': '{ "allow": [',
    'broken/a.js': 'debugger;\nx.toSorted();\n',
    'broken/b.js': 'structuredClone(1);\n',
  })) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const config = { ...oxlintConfig({}), rules: { ...oxlintConfig({}).rules, 'no-debugger': 'error' } };
  const { status, findings } = oxlintRun(config, ['broken']);
  assert.notEqual(status, 0);
  const broken = `exact ${join('broken', 'compatgate.jsonc')}: CloseBracketExpected at offset 12`;
  assert.deepEqual(
    findings.map(finding => finding.replace(/ eslint\(no-debugger\) .*$/, ' no-debugger')).sort(),
    [`broken/a.js:1:1-1:1 ${broken}`, 'broken/a.js:1:1-1:10 no-debugger', `broken/b.js:1:1-1:1 ${broken}`].sort(),
  );
});

function writeConfig(config: Record<string, unknown>): string {
  const path = join(root, `oxlintrc-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}
