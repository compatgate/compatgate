import { test } from 'node:test';
import assert from 'node:assert/strict';

import type * as binding from '../binding.js';
import { createChecker } from './checker.ts';
import type {
  AllowEntry,
  AllowEntryInput,
  Configuration,
  Finding,
  ParseErrorKind,
  Suppression,
} from '../src-js/index.ts';
import type { CoreAllowIssue, CoreCheckResult, CoreChecker } from '../src-js/types.ts';

// The public types are written by hand, so that the generated ones stay internal. These checks make
// `pnpm typecheck` fail when the binding and the public types drift apart. Mutual assignability is not
// enough: it lets an optional field differ, such as `since?` renamed on one side.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// compatgate.schema.json is the source of the keys of an entry of compatgate.jsonc: the input type of an entry has
// the same keys, and `baseDir`, which only the options take.
type Schema = typeof import('../compatgate.schema.json', { with: { type: 'json' } });
type SchemaEntryKeys = keyof Schema['definitions']['entry']['properties'];

const checks: {
  result: Equal<ReturnType<binding.Checker['check']>, CoreCheckResult>;
  checker: Equal<binding.Checker, CoreChecker>;
  issues: Equal<ReturnType<binding.Checker['issues']>, CoreAllowIssue[]>;
  kind: Equal<binding.FindingKind, Finding['kind']>;
  confidence: Equal<binding.FindingConfidence, Finding['confidence']>;
  issueKind: Equal<binding.AllowIssueKind, CoreAllowIssue['kind']>;
  parseErrorKind: Equal<binding.ParseErrorKind, ParseErrorKind>;
  suppression: Equal<binding.SuppressionOutput, Suppression>;
  schemaEntry: Equal<SchemaEntryKeys, Exclude<keyof AllowEntryInput, 'baseDir'>>;
} = {
  result: true,
  checker: true,
  issues: true,
  kind: true,
  confidence: true,
  issueKind: true,
  parseErrorKind: true,
  suppression: true,
  schemaEntry: true,
};

test('the binding types match the public types', () => {
  assert.ok(Object.values(checks).every(Boolean));
});

test('kind and confidence are string literal types', () => {
  const kinds: Finding['kind'][] = ['syntax', 'builtin', 'api'];
  const confidences: Finding['confidence'][] = ['exact', 'heuristic', 'partial'];
  // @ts-expect-error not a kind
  const badKind: Finding['kind'] = 'other';
  // @ts-expect-error not a confidence
  const badConfidence: Finding['confidence'] = 'other';
  void badKind;
  void badConfidence;
  assert.equal(kinds.length, 3);
  assert.equal(confidences.length, 3);
});

test('the binding returns every kind and confidence as a plain string', () => {
  const pairs = (source: string, targets: string) =>
    createChecker({ targets })
      .check(source, 'a.js')
      .findings.map(f => [f.kind, f.confidence]);
  assert.deepEqual(pairs('structuredClone(1);', 'Chrome >= 97'), [['api', 'exact']]);
  assert.deepEqual(pairs('list.toSorted();', 'Chrome >= 97'), [['builtin', 'heuristic']]);
  assert.deepEqual(pairs('class A { static {} }', 'Chrome >= 90'), [['syntax', 'exact']]);
  assert.deepEqual(pairs('new BarcodeDetector();', 'Chrome >= 97'), [['api', 'partial']]);
});

test('the entries of a config are read only in the types, as they are frozen at run time', () => {
  // Never called: the type check alone tests the function.
  const writes = (configuration: Configuration, entry: AllowEntry) => {
    // @ts-expect-error the cached list is frozen
    configuration.entries.push(entry);
    // @ts-expect-error a configuration is frozen
    configuration.targets = 'defaults';
    // @ts-expect-error the source of a cached entry is frozen
    entry.source.index = 1;
    // @ts-expect-error the arrays of a cached entry are frozen
    entry.files.push('**');
    // @ts-expect-error the arrays of a cached entry are frozen
    entry.packages.push('lib');
    // @ts-expect-error a cached entry is frozen
    entry.feature = 'api.X';
  };
  assert.equal(typeof writes, 'function');
});
