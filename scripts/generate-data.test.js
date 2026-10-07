import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSERS,
  UNSUPPORTED,
  browserSupport,
  collectFeatures,
  collectInstanceMembers,
  collectSingletons,
  encodeVersion,
  noteText,
  renderRust,
} from './generate-data.js';

test('encodeVersion', () => {
  assert.equal(encodeVersion('15.4'), (15 << 16) | (4 << 8));
  assert.equal(encodeVersion('1.2.3'), (1 << 16) | (2 << 8) | 3);
  assert.equal(encodeVersion('≤79'), 79 << 16);
  assert.equal(encodeVersion(true), 0);
  assert.equal(encodeVersion('preview'), UNSUPPORTED);
  assert.equal(encodeVersion(false), UNSUPPORTED);
  assert.equal(encodeVersion(null), UNSUPPORTED);
});

test('browserSupport ignores flags, prefixes, alternative names and removed entries', () => {
  const support = browserSupport([
    { version_added: '10', flags: [{ type: 'preference' }] },
    { version_added: '11', prefix: 'webkit' },
    { version_added: '12', alternative_name: 'oldName' },
    { version_added: '13', version_removed: '14' },
    { version_added: '20' },
  ]);
  assert.deepEqual(support, { full: 20 << 16, partial: UNSUPPORTED, note: null });
});

test('browserSupport keeps partial support apart from full support and keeps its note', () => {
  const support = browserSupport([
    { version_added: '30' },
    { version_added: '25', partial_implementation: true, notes: 'Only on <code>macOS</code>.' },
  ]);
  assert.deepEqual(support, { full: 30 << 16, partial: 25 << 16, note: 'Only on macOS.' });
});

test('browserSupport keeps an entry removed only in a preview build', () => {
  const support = browserSupport([{ version_added: '26.4', version_removed: 'preview' }]);
  assert.equal(support.full, (26 << 16) | (4 << 8));
});

test('collectFeatures walks only api and javascript and sorts ids', () => {
  const compat = { support: { chrome: { version_added: '1' } } };
  const features = collectFeatures({
    api: { B: { __compat: compat }, A: { __compat: compat, child: { __compat: compat } } },
    javascript: { builtins: { X: { __compat: compat } } },
    css: { properties: { color: { __compat: compat } } },
  });
  assert.deepEqual(
    features.map(feature => feature.id),
    ['api.A', 'api.A.child', 'api.B', 'javascript.builtins.X'],
  );
  assert.equal(features[0].full.length, BROWSERS.length);
  assert.equal(features[0].full[0], 1 << 16);
});

test('renderRust writes all tables', () => {
  const full = BROWSERS.map(() => UNSUPPORTED);
  const partial = BROWSERS.map((_, index) => (index === 2 ? 5 << 16 : UNSUPPORTED));
  const notes = BROWSERS.map((_, index) => (index === 2 ? 'Only on "macOS".' : null));
  const text = renderRust(
    [{ id: 'api.A', full, partial, notes }],
    '1.0.0',
    [{ name: 'm', id: 'api.A', reportable: false }],
    [{ name: 'a', type: 'A' }],
  );
  assert.match(text, /pub const BCD_VERSION: &str = "1\.0\.0";/);
  assert.match(text, /pub const BROWSER_KEYS: \[&str; 11\] = \["chrome", "chrome_android"/);
  assert.match(text, /\("api\.A", \[U, U, U, U, U, U, U, U, U, U, U\]\),/);
  assert.match(text, /\(0, 2, 327680, 0\),/);
  assert.match(text, /pub static NOTES: &\[&str\] = &\[\n {4}"Only on \\"macOS\\"\.",/);
  assert.match(text, /\("m", 0, false\),/);
  assert.match(text, /\("a", "A"\),/);
});

test('--check passes when the committed data matches the generator output', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, [new URL('./generate-data.js', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
  });
  assert.match(output, /up to date/);
});

test('noteText strips HTML and takes the first note', () => {
  assert.equal(noteText(['See <a href="https://bugs/1">bug 1</a>.\n  More.', 'Second']), 'See bug 1. More.');
  assert.equal(noteText(undefined), null);
});

test('collectInstanceMembers keeps getters and setters of builtins but does not report them', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        ArrayBuffer: {
          detached: compat('https://tc39.es/#sec-get-arraybuffer.prototype.detached'),
          transfer: compat('https://tc39.es/#sec-arraybuffer.prototype.transfer'),
        },
        Example: {
          value: compat(['https://tc39.es/#sec-set-example.prototype.value']),
        },
      },
    },
    api: {},
  });
  assert.deepEqual(members, [
    { name: 'detached', id: 'javascript.builtins.ArrayBuffer.detached', reportable: false },
    { name: 'transfer', id: 'javascript.builtins.ArrayBuffer.transfer', reportable: true },
    { name: 'value', id: 'javascript.builtins.Example.value', reportable: false },
  ]);
});

test('collectInstanceMembers takes prototype members of builtins and members of Web API interfaces', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        Array: {
          Array: compat('https://tc39.es/#sec-array-constructor'),
          from: compat('https://tc39.es/#sec-array.from'),
          toSorted: compat('https://tc39.es/#sec-array.prototype.tosorted'),
          '@@iterator': compat('https://tc39.es/#sec-array.prototype-@@iterator'),
        },
      },
    },
    api: {
      Element: {
        Element: compat(''),
        toggleAttribute: compat(''),
        click_event: compat(''),
        getHTML_static: compat(''),
      },
    },
  });
  assert.deepEqual(members, [
    { name: 'toSorted', id: 'javascript.builtins.Array.toSorted', reportable: true },
    { name: 'toggleAttribute', id: 'api.Element.toggleAttribute', reportable: false },
  ]);
});

test('collectSingletons maps global variables to interfaces with BCD data', () => {
  const declarations = [
    'declare var navigator: Navigator;',
    'declare var window: Window & typeof globalThis;',
    'declare var visualViewport: VisualViewport | null;',
    'declare var ResizeObserver: {',
    'declare var unknownThing: UnknownInterface;',
  ].join('\n');
  const ids = new Set(['api.Navigator', 'api.Window', 'api.VisualViewport']);
  assert.deepEqual(collectSingletons(declarations, ids), [
    { name: 'navigator', type: 'Navigator' },
    { name: 'visualViewport', type: 'VisualViewport' },
    { name: 'window', type: 'Window' },
  ]);
});
