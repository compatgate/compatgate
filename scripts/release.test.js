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

test('an upload of a hidden directory includes its files', () => {
  // upload-artifact skips hidden files by default, and every file of a directory whose name starts with a dot counts
  // as hidden: the job packs the release and uploads nothing.
  for (const name of ['release.yml', 'build.yml', 'ci.yml']) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
    const steps = workflow.split(/\n(?= {6}- )/).filter(step => step.includes('actions/upload-artifact@'));
    for (const step of steps) {
      const hidden = /^ {10}path: \.|^ {12}\./m.test(step);
      assert.ok(!hidden || /^ {10}include-hidden-files: true$/m.test(step), `${name}:\n${step}`);
    }
  }
});
