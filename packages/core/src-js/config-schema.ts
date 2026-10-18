import { isDeepStrictEqual } from 'node:util';

import { isString, type OptionRule, type OptionSchema } from './options.ts';

/** A node of compatgate.schema.json, as far as the core reads it. */
export interface SchemaNode {
  readonly type?: string;
  readonly $ref?: string;
  readonly anyOf?: readonly SchemaNode[];
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly definitions?: Readonly<Record<string, SchemaNode>>;
  /** For the editor only: the core checks a feature id against its data. */
  readonly pattern?: string;
  /** For the editor only. */
  readonly description?: string;
}

/** A string, or a list of strings: `stringList` of allow.ts turns it into a list. */
const STRINGS: OptionRule = [
  value => typeof value === 'string' || (Array.isArray(value) && value.every(isString)),
  'a string or an array of strings',
];
const STRING: OptionRule = [isString, 'a string'];
const ARRAY: OptionRule = [Array.isArray, 'an array'];

/** The definition `name` of the schema. A missing one would leave its object without keys, so every value fails. */
export function definitionOf(root: SchemaNode, name: string): SchemaNode {
  const node = root.definitions?.[name];
  if (node === undefined) {
    throw new Error(`compatgate.schema.json: no definition "${name}". This is a bug of compatgate`);
  }
  return node;
}

/**
 * The rules of the keys of an object of the schema. `pattern` and `description` are for the editor: the core checks
 * a feature id against its data, with a suggestion.
 */
export function rulesOf(node: SchemaNode, root: SchemaNode): OptionSchema {
  return Object.fromEntries(
    Object.entries(node.properties ?? {}).map(([key, value]) => [key, ruleOf(value, root, key)]),
  );
}

// The forms of the schema that the core knows, and their rules. A node must match a form exactly, without its
// keywords for the editor: any other keyword fails at the load of the module, so the schema cannot check a key
// more strictly than the core.
const FORMS: ReadonlyArray<readonly [SchemaNode, OptionRule]> = [
  [{ type: 'string' }, STRING],
  [{ anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, STRINGS],
  // The entries of `allow`: the core checks each of them itself, in `toEntry` of allow.ts.
  [{ type: 'array', items: { anyOf: [{ $ref: '#/definitions/featureId' }, { $ref: '#/definitions/entry' }] } }, ARRAY],
];

function ruleOf(node: SchemaNode, root: SchemaNode, key: string): OptionRule {
  const { description: _, pattern: __, ...form } = node;
  const name = /^#\/definitions\/([^/]+)$/.exec(form.$ref ?? '')?.[1];
  if (name !== undefined && Object.keys(form).length === 1) {
    return ruleOf(definitionOf(root, name), root, key);
  }
  const rule = FORMS.find(([known]) => isDeepStrictEqual(form, known))?.[1];
  if (rule === undefined) {
    throw new Error(`compatgate.schema.json: no rule for the form of "${key}". This is a bug of compatgate`);
  }
  return rule;
}
