import { test } from 'node:test';
import assert from 'node:assert/strict';

import { definitionOf, rulesOf, type SchemaNode } from '../src-js/config-schema.ts';

const ROOT: SchemaNode = {
  definitions: { strings: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } },
};

test('a string, a string or an array of strings, and an array give their rules', () => {
  const rules = rulesOf(
    {
      properties: {
        name: { type: 'string', pattern: '^x', description: 'for the editor only' },
        list: { $ref: '#/definitions/strings', description: 'for the editor only' },
        items: {
          type: 'array',
          items: { anyOf: [{ $ref: '#/definitions/featureId' }, { $ref: '#/definitions/entry' }] },
        },
      },
    },
    ROOT,
  );
  assert.deepEqual(Object.keys(rules), ['name', 'list', 'items']);
  const [isName, name] = rules.name ?? [];
  const [isList, list] = rules.list ?? [];
  const [isItems, items] = rules.items ?? [];
  assert.ok(isName && isList && isItems);
  assert.equal(name, 'a string');
  assert.ok(isName('y', 'w'), 'the core does not apply the pattern: the check of the id gives a better message');
  assert.ok(!isName(1, 'w'));
  assert.equal(list, 'a string or an array of strings');
  assert.ok(isList('a', 'w') && isList(['a', 'b'], 'w'));
  assert.ok(!isList([1], 'w') && !isList({}, 'w'));
  assert.equal(items, 'an array');
  assert.ok(isItems([], 'w') && !isItems('a', 'w'));
});

test('a form of the schema without a rule is an error that names the key', () => {
  assert.throws(() => rulesOf({ properties: { count: { type: 'number' } } }, ROOT), /no rule for the form of "count"/);
  assert.throws(
    () => rulesOf({ properties: { other: { $ref: '#/definitions/missing' } } }, ROOT),
    /no definition "missing"/,
  );
});

test('a keyword that the core does not apply is an error: the schema would be stricter than the core', () => {
  for (const node of [
    { type: 'string', enum: ['a', 'b'] },
    { type: 'string', minLength: 3 },
    { type: 'array', items: { type: 'number' } },
    { type: 'array' },
    { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' } }] },
    {
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    { $ref: '#/definitions/strings', minItems: 1 },
  ]) {
    assert.throws(
      () => rulesOf({ properties: { key: node as SchemaNode } }, ROOT),
      /no rule for the form of "key"/,
      JSON.stringify(node),
    );
  }
});

test('a definition that the schema lacks is an error, not an object without keys', () => {
  assert.deepEqual(definitionOf(ROOT, 'strings'), ROOT.definitions?.strings);
  assert.throws(() => definitionOf(ROOT, 'entry'), /compatgate\.schema\.json: no definition "entry"/);
});
