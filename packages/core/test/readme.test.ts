// The README is the reference of the API on npm: these tests keep it in step with the code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as core from '../src-js/index.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the README lists every method of a resolver', () => {
  const block = /interface Resolver \{\n([\s\S]*?)\n\}/.exec(readme)?.[1] ?? '';
  const documented = [...block.matchAll(/^ {2}(\w+)\(/gm)].map(match => match[1]);
  const methods = Object.keys(core.createResolver({ targets: 'Chrome >= 97', allow: [] }));
  assert.deepEqual(documented.sort(), methods.sort());
});

test('the README has a section for every function of the package', () => {
  const headings = new Set([...readme.matchAll(/^### (\w+)\(/gm)].map(match => match[1]));
  const functions = Object.entries(core)
    .filter(([name, value]) => typeof value === 'function' && !name.endsWith('Error'))
    .map(([name]) => name);
  assert.deepEqual(
    functions.filter(name => !headings.has(name)),
    [],
  );
});
