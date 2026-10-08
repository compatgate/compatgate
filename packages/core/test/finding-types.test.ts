import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as binding from '../binding.js';

type Finding = binding.FindingOutput;

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
    binding.check(source, { filename: 'a.js', targets }).findings.map(f => [f.kind, f.confidence]);
  assert.deepEqual(pairs('structuredClone(1);', 'Chrome >= 97'), [['api', 'exact']]);
  assert.deepEqual(pairs('list.toSorted();', 'Chrome >= 97'), [['builtin', 'heuristic']]);
  assert.deepEqual(pairs('class A { static {} }', 'Chrome >= 90'), [['syntax', 'exact']]);
  assert.deepEqual(pairs('new BarcodeDetector();', 'Chrome >= 97'), [['api', 'partial']]);
});
