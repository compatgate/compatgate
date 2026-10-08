import { test } from 'node:test';
import assert from 'node:assert/strict';

import type * as binding from '../binding.js';
import { createChecker } from '../src-js/index.ts';
import type { AllowIssue, CheckResult, Checker, Finding, ParseErrorKind } from '../src-js/index.ts';

// The public types are written by hand, so that the generated ones stay internal. These checks make
// `pnpm typecheck` fail when the binding and the public types drift apart. Mutual assignability is not
// enough: it lets an optional field differ, such as `since?` renamed on one side.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const checks: {
  result: Equal<ReturnType<binding.Checker['check']>, CheckResult>;
  checker: Equal<binding.Checker, Checker>;
  issues: Equal<ReturnType<typeof binding.validateAllow>, AllowIssue[]>;
  kind: Equal<binding.FindingKind, Finding['kind']>;
  confidence: Equal<binding.FindingConfidence, Finding['confidence']>;
  issueKind: Equal<binding.AllowIssueKind, AllowIssue['kind']>;
  parseErrorKind: Equal<binding.ParseErrorKind, ParseErrorKind>;
} = {
  result: true,
  checker: true,
  issues: true,
  kind: true,
  confidence: true,
  issueKind: true,
  parseErrorKind: true,
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
