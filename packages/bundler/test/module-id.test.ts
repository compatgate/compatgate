import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isCheckable } from '@compatgate/core';

import {
  COMPONENT_EXTENSIONS,
  ESBUILD_FILTER,
  SCRIPT_LOADERS,
  TRANSFORM_FILTER,
  isScript,
  moduleFile,
  moduleFileOf,
} from '../src/module-id.ts';

test('the table of scripts holds the extensions that the core parses', () => {
  const names = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'd.ts', 'd.mts', 'JS', 'Tsx', 'MTS']
    .concat(['mjsx', 'cjsx', 'mtsx', 'ctsx', 'jsm', 'es6', 'vue', 'svelte', 'astro', 'css', 'json', 'md', 'map'])
    .map(extension => `/p/a.${extension}`)
    .concat(['/p/.ts', '/p/Makefile', '/p/a.ts/b', 'C:\\p\\A.TS', 'C:\\p.ts\\b', '/p/a.ts?v=1']);
  for (const name of names) {
    assert.equal(isScript(name), isCheckable(name), name);
  }
  for (const extension of Object.keys(SCRIPT_LOADERS)) {
    assert.ok(isCheckable(`/p/a${extension}`), extension);
  }
});

test('the filters of the bundlers come from the table', () => {
  const transform = (id: string) => TRANSFORM_FILTER.include.test(id) && !TRANSFORM_FILTER.exclude.test(id);
  for (const extension of [...Object.keys(SCRIPT_LOADERS), ...COMPONENT_EXTENSIONS]) {
    assert.ok(transform(`/p/a${extension}`), extension);
    assert.ok(transform(`/p/a${extension.toUpperCase()}?v=1`), extension);
    assert.equal(ESBUILD_FILTER.test(`/p/a${extension}`), extension in SCRIPT_LOADERS, extension);
  }
  for (const id of ['/p/a.mjsx', '/p/a.css', '/p/a.json']) {
    assert.ok(!transform(id), id);
    assert.ok(!ESBUILD_FILTER.test(id), id);
  }
});

test('a checkable file is parsed by its own extension and needs no `parseAs`', () => {
  assert.deepEqual(moduleFile('/src/a.ts'), { path: '/src/a.ts' });
  assert.deepEqual(moduleFile('/src/a.MJS'), { path: '/src/a.MJS' });
});

test('the query and the hash are cut from the path', () => {
  assert.deepEqual(moduleFile('/src/a.ts?v=123'), { path: '/src/a.ts' });
  assert.deepEqual(moduleFile('/src/a.js#hash'), { path: '/src/a.js' });
  assert.deepEqual(moduleFile('/src/a.js?x#y'), { path: '/src/a.js' });
});

test('a Windows path keeps its separators', () => {
  assert.deepEqual(moduleFile('C:\\p\\a.ts?x'), { path: 'C:\\p\\a.ts' });
  assert.deepEqual(moduleFile('C:/p/a.ts'), { path: 'C:/p/a.ts' });
});

test('a component is JavaScript: its framework plugin has compiled it before the check', () => {
  assert.deepEqual(moduleFile('/src/App.vue'), { path: '/src/App.vue', parseAs: '/src/App.vue.js' });
  assert.deepEqual(moduleFile('/src/App.svelte'), { path: '/src/App.svelte', parseAs: '/src/App.svelte.js' });
  assert.deepEqual(moduleFile('/src/Page.astro'), { path: '/src/Page.astro', parseAs: '/src/Page.astro.js' });
});

test('the language of the query selects the parser: `lang.ts` of Vite and `lang=ts` of vue-loader', () => {
  assert.deepEqual(moduleFile('/src/App.vue?vue&type=script&lang.ts'), {
    path: '/src/App.vue',
    parseAs: '/src/App.vue.ts',
  });
  assert.deepEqual(moduleFile('/src/App.vue?vue&type=script&setup=true&lang.tsx'), {
    path: '/src/App.vue',
    parseAs: '/src/App.vue.tsx',
  });
  assert.deepEqual(moduleFile('/src/App.vue?vue&type=script&lang=ts'), {
    path: '/src/App.vue',
    parseAs: '/src/App.vue.ts',
  });
  assert.deepEqual(moduleFile('C:\\p\\App.vue?vue&type=script&lang=ts'), {
    path: 'C:\\p\\App.vue',
    parseAs: 'C:\\p\\App.vue.ts',
  });
});

test('a language that is no JavaScript or TypeScript is not checked', () => {
  assert.equal(moduleFile('/src/App.vue?vue&type=style&index=0&lang.css'), null);
  assert.equal(moduleFile('/src/App.vue?vue&type=style&index=0&lang=scss'), null);
  assert.equal(moduleFile('/src/App.svelte?svelte&type=style&lang.css'), null);
});

test('a style block of a component is not checked, even without a language', () => {
  assert.equal(moduleFile('/src/App.vue?vue&type=style&index=0'), null);
});

test('styles, data and assets are not checked', () => {
  assert.equal(moduleFile('/src/a.css?inline'), null);
  assert.equal(moduleFile('/src/a.css'), null);
  assert.equal(moduleFile('/src/data.json'), null);
  assert.equal(moduleFile('/src/logo.svg?url'), null);
  assert.equal(moduleFile('/src/LICENSE'), null);
});

test('virtual and relative modules are not checked', () => {
  assert.equal(moduleFile('\0virtual:x'), null);
  assert.equal(moduleFile('\0/src/a.js'), null);
  assert.equal(moduleFile('virtual:y'), null);
  assert.equal(moduleFile('App.vue?vue&type=script&lang=ts'), null);
  assert.equal(moduleFile('src/a.ts'), null);
  assert.equal(moduleFile(''), null);
});

test('a path and a query given apart keep a `#` of the path', () => {
  assert.deepEqual(moduleFileOf('/p/C#/a.ts', ''), { path: '/p/C#/a.ts' });
  assert.deepEqual(moduleFileOf('/p/C#/App.vue', '?vue&type=script&lang=ts'), {
    path: '/p/C#/App.vue',
    parseAs: '/p/C#/App.vue.ts',
  });
  assert.equal(moduleFileOf('/p/C#/a.css', '?inline'), null);
  assert.equal(moduleFileOf('virtual:x', ''), null);
});
