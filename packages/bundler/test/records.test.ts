import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GraphModule } from '../src/hosts/host.ts';
import { moduleFile } from '../src/module-id.ts';
import { ModuleRecords, type ModuleRecord } from '../src/records.ts';

const record = (used: number[] = []): ModuleRecord => ({ configuration: null, used, partials: [] });
const module = (id: string, built?: boolean): GraphModule => ({
  id,
  file: () => moduleFile(id),
  ...(built === undefined ? {} : { built: () => built }),
});
const selectAll = (file: unknown) => file as ReturnType<typeof moduleFile>;

test('the records of a build serve the next one, and a module that leaves the graph leaves them', () => {
  const records = new ModuleRecords();
  const a = record([0]);
  const b = record([1]);
  records.set('/p/a.ts', a, true);
  records.set('/p/b.ts', b, true);
  assert.ok(records.fresh());
  assert.deepEqual(records.collect([module('/p/a.ts'), module('/p/b.ts')], selectAll), [a, b]);

  // The next build takes a.ts from a cache, and b.ts is gone.
  records.startBuild();
  assert.ok(!records.fresh());
  assert.deepEqual(records.collect([module('/p/a.ts')], selectAll), [a]);
  assert.deepEqual([...records.all()], [a]);
});

test('a checked module without a record makes the walk incomplete; a module that is not checked does not', () => {
  const records = new ModuleRecords();
  const a = record();
  records.set('/p/a.ts', a, true);
  assert.equal(records.collect([module('/p/a.ts'), module('/p/b.ts')], selectAll), null);
  assert.deepEqual(
    records.collect([module('/p/a.ts'), module('/p/b.ts')], () => null),
    [a],
  );
  assert.equal(records.collect(null, selectAll), null);
});

test('an incomplete walk still drops the records of the modules that left the graph', () => {
  const records = new ModuleRecords();
  const a = record();
  records.set('/p/a.ts', a, true);
  records.set('/p/b.ts', record(), true);
  records.startBuild();
  assert.equal(records.collect([module('/p/c.ts'), module('/p/a.ts')], selectAll), null);
  assert.deepEqual([...records.all()], [a]);
});

test('a failed build drops the records that it set: the bundler may keep the code before it', () => {
  const records = new ModuleRecords();
  const a = record([0]);
  records.set('/p/a.ts', a, true);
  records.startBuild();
  records.set('/p/a.ts', record([1]), true);
  records.set('/p/child.ts', record([1]), false);
  records.dropBuild();
  assert.deepEqual([...records.all()], []);
  assert.equal(records.collect([module('/p/a.ts')], selectAll), null);
});

test('a module that the bundler built without the transform has a record of older code', () => {
  const records = new ModuleRecords();
  const a = record();
  records.set('/p/a.ts', a, true);
  records.startBuild();
  // Another loader failed on the new code of a.ts: the transform of compatgate never saw it.
  assert.equal(records.collect([module('/p/a.ts', true)], selectAll), null);
  assert.deepEqual([...records.all()], []);
  // A module from a cache keeps its record; a module of this build counts whatever the bundler says.
  records.set('/p/a.ts', a, true);
  records.startBuild();
  assert.deepEqual(records.collect([module('/p/a.ts', false)], selectAll), [a]);
  records.set('/p/a.ts', a, true);
  assert.deepEqual(records.collect([module('/p/a.ts', true)], selectAll), [a]);
});

test('a record outside the graph counts for the entries, and the walk neither needs nor drops it', () => {
  const records = new ModuleRecords();
  const a = record([0]);
  const child = record([1]);
  records.set('/p/a.ts', a, true);
  records.set('/p/child.ts', child, false);
  assert.deepEqual(records.collect([module('/p/a.ts')], selectAll), [a]);
  assert.deepEqual([...records.all()], [a, child]);
});
