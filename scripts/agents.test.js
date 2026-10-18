// AGENTS.md guides agents and people through the repository: a renamed file or script must not leave it behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const agents = readFileSync(new URL('AGENTS.md', root), 'utf8');
const { scripts } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

// A generated file that is not committed, such as THIRD-PARTY-LICENSE, is missing from a fresh checkout.
const ignored = path => {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: fileURLToPath(root) });
    return true;
  } catch {
    return false;
  }
};

test('every path of the repository that AGENTS.md names exists or is ignored by git', () => {
  // A path from the root, in backticks, without a glob or a placeholder.
  const paths = [
    ...agents.matchAll(/`((?:\.github|\.changeset|crates|packages|scripts|conformance)\/[^`\s*<>…]+)`/g),
  ].map(match => match[1]);
  assert.ok(paths.length > 20, `only ${paths.length} paths found`);
  assert.deepEqual(
    paths.filter(path => !existsSync(new URL(path, root)) && !ignored(path)),
    [],
  );
});

test('every root script that AGENTS.md runs exists', () => {
  const runs = [...agents.matchAll(/pnpm run ([\w:-]+)/g)].map(match => match[1]);
  assert.ok(runs.length > 0);
  assert.deepEqual(
    runs.filter(name => !(name in scripts)),
    [],
  );
});
