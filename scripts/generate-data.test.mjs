import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BROWSERS, UNSUPPORTED, browserSupport, collectFeatures, encodeVersion, renderRust } from './generate-data.mjs';

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
  assert.deepEqual(support, { full: 20 << 16, partial: UNSUPPORTED });
});

test('browserSupport keeps partial support apart from full support', () => {
  const support = browserSupport([{ version_added: '30' }, { version_added: '25', partial_implementation: true }]);
  assert.deepEqual(support, { full: 30 << 16, partial: 25 << 16 });
});

test('collectFeatures walks only api and javascript and sorts ids', () => {
  const compat = { support: { chrome: { version_added: '1' } } };
  const features = collectFeatures({
    api: { B: { __compat: compat }, A: { __compat: compat, child: { __compat: compat } } },
    javascript: { builtins: { X: { __compat: compat } } },
    css: { properties: { color: { __compat: compat } } },
  });
  assert.deepEqual(features.map(feature => feature.id), ['api.A', 'api.A.child', 'api.B', 'javascript.builtins.X']);
  assert.equal(features[0].full.length, BROWSERS.length);
  assert.equal(features[0].full[0], 1 << 16);
});

test('renderRust writes browser keys, features and sparse partial support', () => {
  const full = BROWSERS.map(() => UNSUPPORTED);
  const partial = BROWSERS.map((_, index) => (index === 2 ? 5 << 16 : UNSUPPORTED));
  const text = renderRust([{ id: 'api.A', full, partial }], '1.0.0');
  assert.match(text, /pub const BCD_VERSION: &str = "1\.0\.0";/);
  assert.match(text, /pub const BROWSER_KEYS: \[&str; 11\] = \["chrome", "chrome_android"/);
  assert.match(text, /\("api\.A", \[U, U, U, U, U, U, U, U, U, U, U\]\),/);
  assert.match(text, /\(0, 2, 327680\),/);
});
