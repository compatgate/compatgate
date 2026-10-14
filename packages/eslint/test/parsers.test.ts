import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import typescriptParser from '@typescript-eslint/parser';

import { createResolver } from '@compatgate/core';
import plugin from '../src/index.ts';

const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';
const RULES: Linter.RulesRecord = {
  'compatgate/exact': 'error',
  'compatgate/heuristic': 'error',
  'compatgate/partial': 'error',
};

/** The positions of the core findings, in the 1-based columns of ESLint messages, by line and column. */
function corePositions(source: string, filename: string, syntax: boolean): string[] {
  return createResolver({ targets: TARGETS, allow: [] })
    .check(source, filename)
    .findings.filter(finding => syntax || finding.kind !== 'syntax')
    .map(
      finding =>
        `${finding.start.line}:${finding.start.column + 1}-${finding.end.line}:${finding.end.column + 1} ${finding.feature}`,
    )
    .sort();
}

function eslintPositions(messages: Linter.LintMessage[]): string[] {
  assert.deepEqual(
    messages.filter(message => message.fatal),
    [],
  );
  return messages
    .map(
      message =>
        `${message.line}:${message.column}-${message.endLine}:${message.endColumn} ${message.message.split(' ')[0]}`,
    )
    .sort();
}

// Non-ASCII text and a surrogate pair before the findings: columns are UTF-16 code units in both.
const TYPESCRIPT = `type Point = { x: number };
const label: string = 'ж😀'; const copy = structuredClone<Point>({ x: 1 });
function sort<T>(items: T[]): T[] { return items.toSorted(); }
enum Mode { A }
class Box { value = Object.groupBy([], (item: unknown) => item); }
const r = /(?<=a)b/;
`;

const JSX = `const label = 'ж😀';
export const App = () => <div title={label}>{structuredClone(1)}{new Intl.Segmenter().segment('a')}</div>;
`;

for (const syntax of [false, true]) {
  test(`TypeScript findings are at the positions of the core, syntax ${syntax}`, () => {
    const filename = '/p/a.ts';
    const messages = new Linter({ cwd: '/p' }).verify(
      TYPESCRIPT,
      {
        files: ['**/*.ts'],
        plugins: { compatgate: plugin },
        rules: RULES,
        languageOptions: { parser: typescriptParser },
        settings: { compatgate: { targets: TARGETS, allow: [], syntax } },
      },
      filename,
    );
    const expected = corePositions(TYPESCRIPT, filename, syntax);
    assert.ok(expected.length === (syntax ? 5 : 3), expected.join('\n'));
    assert.deepEqual(eslintPositions(messages), expected);
  });

  test(`JSX findings are at the positions of the core, syntax ${syntax}`, () => {
    for (const filename of ['/p/a.jsx', '/p/a.tsx']) {
      const messages = new Linter({ cwd: '/p' }).verify(
        JSX,
        {
          files: ['**/*.jsx', '**/*.tsx'],
          plugins: { compatgate: plugin },
          rules: RULES,
          languageOptions: {
            ...(filename.endsWith('.tsx') ? { parser: typescriptParser } : {}),
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          settings: { compatgate: { targets: TARGETS, allow: [], syntax } },
        },
        filename,
      );
      const expected = corePositions(JSX, filename, syntax);
      assert.equal(expected.length, 2, expected.join('\n'));
      assert.deepEqual(eslintPositions(messages), expected);
    }
  });
}
