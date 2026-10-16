import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listsVersion } from './unpublished.js';

test('a package that npm lacks has no version', () => {
  assert.equal(listsVersion(404, undefined, '0.1.0'), false);
});

test('a package lists the versions that npm has', () => {
  const body = { versions: { '0.1.0-next.0': {}, '0.1.0': {} } };
  assert.equal(listsVersion(200, body, '0.1.0'), true);
  assert.equal(listsVersion(200, body, '0.1.1'), false);
});

test('any other answer of the registry is an error, not a missing version', () => {
  assert.throws(() => listsVersion(503, undefined, '0.1.0'), /the registry answered 503/);
});
