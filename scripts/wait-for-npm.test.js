import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForPackages } from './wait-for-npm.js';

const packages = [
  { name: '@compatgate/core', version: '0.1.0' },
  { name: '@compatgate/eslint', version: '0.1.0' },
];

test('the wait ends when npm serves every package, and asks again only for the missing ones', async () => {
  const asked = [];
  let round = 0;
  await waitForPackages(packages, {
    isPublished: async name => {
      asked.push(`${round}:${name}`);
      return name === '@compatgate/core' || round > 0;
    },
    sleep: async () => {
      round += 1;
    },
    attempts: 3,
  });
  assert.deepEqual(asked, ['0:@compatgate/core', '0:@compatgate/eslint', '1:@compatgate/eslint']);
});

test('a package that npm does not serve in time is an error that names it', async () => {
  await assert.rejects(
    waitForPackages(packages, {
      isPublished: async name => name === '@compatgate/core',
      sleep: async () => {},
      attempts: 3,
    }),
    /npm does not serve @compatgate\/eslint@0\.1\.0 after 3 attempts/,
  );
});

test('an error of the registry counts as a package not served yet', async () => {
  let round = 0;
  await waitForPackages(packages, {
    isPublished: async () => {
      if (round === 0) {
        throw new Error('the registry answered 503');
      }
      return true;
    },
    sleep: async () => {
      round += 1;
    },
    attempts: 3,
  });
  assert.equal(round, 1);
});

test('a wait that ends on errors of the registry names the last one', async () => {
  await assert.rejects(
    waitForPackages(packages, {
      isPublished: async () => {
        throw new Error('the registry answered 429');
      },
      sleep: async () => {},
      attempts: 2,
    }),
    /after 2 attempts.*the registry answered 429/s,
  );
});
