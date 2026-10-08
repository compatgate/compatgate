import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LruCache } from '../src-js/cache.ts';

test('the cache creates a value once per key', () => {
  const cache = new LruCache<string, object>(2);
  let created = 0;
  const create = () => ({ id: ++created });
  const a = cache.get('a', create);
  assert.equal(cache.get('a', create), a);
  assert.equal(created, 1);
});

test('the cache drops the least recently used key', () => {
  const cache = new LruCache<string, number>(2);
  let created = 0;
  const create = () => ++created;
  cache.get('a', create);
  cache.get('b', create);
  // A hit makes `a` the most recent, so `b` goes when `c` comes.
  cache.get('a', create);
  cache.get('c', create);
  assert.equal(created, 3);
  assert.equal(cache.get('a', create), 1);
  assert.equal(created, 3);
  assert.equal(cache.get('b', create), 4);
});
