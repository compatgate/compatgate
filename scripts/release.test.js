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
  // release.yml publishes the platform packages in a step of its own and waits for npm to serve them: the publish of
  // the core must not publish them again.
  const core = JSON.parse(readFileSync(new URL('packages/core/package.json', root), 'utf8'));
  assert.equal(core.scripts.prepublishOnly, 'napi pre-publish -t npm --no-gh-release --skip-optional-publish');
});
