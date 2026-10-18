import { test } from 'node:test';
import assert from 'node:assert/strict';

import { publishAll, tarballName } from './publish.js';

const entries = [
  { name: '@compatgate/core-linux-x64-gnu', version: '0.1.1', file: 'compatgate-core-linux-x64-gnu-0.1.1.tgz' },
  { name: '@compatgate/core-darwin-arm64', version: '0.1.1', file: 'compatgate-core-darwin-arm64-0.1.1.tgz' },
];

test('a publish skips a version that npm already has, so a rerun publishes only the rest', async () => {
  const published = [];
  await publishAll(entries, {
    isPublished: async name => name === '@compatgate/core-linux-x64-gnu',
    publish: entry => published.push(entry.name),
  });
  assert.deepEqual(published, ['@compatgate/core-darwin-arm64']);
});

test('an error of the registry stops the publish before the package', async () => {
  const published = [];
  await assert.rejects(
    publishAll(entries, {
      isPublished: async () => {
        throw new Error('the registry answered 503');
      },
      publish: entry => published.push(entry.name),
    }),
    /the registry answered 503/,
  );
  assert.deepEqual(published, []);
});

test('the tarball of a scoped package is named as npm and pnpm name it', () => {
  assert.equal(tarballName('@compatgate/core-linux-x64-gnu', '0.1.1'), 'compatgate-core-linux-x64-gnu-0.1.1.tgz');
  assert.equal(tarballName('@compatgate/eslint', '0.1.1-next.0'), 'compatgate-eslint-0.1.1-next.0.tgz');
});
