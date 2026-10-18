// compatgate.schema.json is the source of the structure of compatgate.jsonc: editors check the file by it, and the
// core takes its rules from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Ajv } from 'ajv';
import jsonc from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

const schema: unknown = JSON.parse(readFileSync(new URL('../compatgate.schema.json', import.meta.url), 'utf8'));
// Strict mode rejects unknown keywords: a typo in the schema would make a key unchecked without a word.
const ajv = new Ajv({ strict: true, allErrors: true });

function validate(config: unknown): string {
  const check = ajv.compile(schema as object);
  return check(config) ? '' : ajv.errorsText(check.errors);
}

test('the schema is a valid JSON Schema draft-07', () => {
  assert.ok(ajv.validateSchema(schema as object), ajv.errorsText(ajv.errors));
});

test('the example of the README passes the schema', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const example = /### compatgate\.jsonc[\s\S]*?```jsonc\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(example, 'no jsonc example in the section compatgate.jsonc of the README');
  const errors: ParseError[] = [];
  const config: unknown = jsonc.parse(example, errors, { allowTrailingComma: true });
  assert.deepEqual(errors, []);
  assert.equal(validate(config), '');
});

test('the schema takes both forms of every key', () => {
  for (const config of [
    {},
    { $schema: './node_modules/@compatgate/core/compatgate.schema.json' },
    { extends: 'base' },
    { extends: ['base', '@company/compat-allow/strict.jsonc'] },
    { allow: ['api.fetch', 'javascript.builtins.Array.toSorted'] },
    { allow: [{ feature: 'api.ResizeObserver', packages: 'some-lib', files: ['src/**'] }] },
    { allow: [{ feature: 'api.ResizeObserver', packages: ['a', 'b'], files: 'src/**' }] },
  ]) {
    assert.equal(validate(config), '', JSON.stringify(config));
  }
});

test('the schema rejects an unknown key, a wrong type and an id outside api and javascript', () => {
  for (const config of [
    { unknown: 1 },
    { $schema: 1 },
    { extends: {} },
    { extends: [1] },
    { allow: 'api.fetch' },
    { allow: ['fetch'] },
    { allow: [{ packages: ['a'] }] },
    { allow: [{ feature: 'api.fetch', file: ['src/**'] }] },
    { allow: [{ feature: 'api.fetch', packages: [1] }] },
    { allow: [{ feature: 'css.properties.color' }] },
  ]) {
    assert.notEqual(validate(config), '', JSON.stringify(config));
  }
});

test('every key names the section of the README about the file', () => {
  const nodes = schema as {
    properties: Record<string, { description?: string }>;
    definitions: {
      entry: { properties: Record<string, { description?: string }> };
      featureId: { description?: string };
    };
  };
  const keys = { ...nodes.properties, ...nodes.definitions.entry.properties, feature: nodes.definitions.featureId };
  for (const [key, node] of Object.entries(keys)) {
    if (key !== '$schema') {
      assert.match(node.description ?? '', /packages\/core#compatgatejsonc/, key);
    }
  }
});
