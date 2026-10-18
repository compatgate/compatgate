import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);

test('pnpm releases the three packages together and keeps their changelogs in the repository', () => {
  const workspace = readFileSync(new URL('pnpm-workspace.yaml', root), 'utf8');
  assert.match(
    workspace,
    /^versioning:\n {2}fixed:\n {4}- \['@compatgate\/core', '@compatgate\/eslint', '@compatgate\/bundler'\]$/m,
  );
  assert.match(workspace, /^ {2}ignore:\n {4}- conformance\n {4}- '@compatgate\/test-utils'$/m);
  assert.match(workspace, /^ {2}changelog:\n {4}storage: repository$/m);
  // A major change waits in a branch of its own: `main` releases minors and patches only.
  assert.match(workspace, /^ {2}maxBump: minor$/m);
  assert.equal(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts.change, 'pnpm change');
  // release.yml packs the tarballs and publishes them with `--ignore-scripts`; `pnpm pack` runs no prepublishOnly. A
  // publish from a machine stops: the core needs the optionalDependencies that napi writes in the job pack.
  for (const name of ['core', 'eslint', 'bundler']) {
    const manifest = JSON.parse(readFileSync(new URL(`packages/${name}/package.json`, root), 'utf8'));
    assert.match(manifest.scripts.prepublishOnly, /release\.yml/);
    assert.match(manifest.scripts.prepublishOnly, /exit 1/);
  }
});
