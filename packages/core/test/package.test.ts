import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

test('the published tarball holds the loader and dist, but no native binary', () => {
  const [report] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageDir, encoding: 'utf8' }),
  );
  const files: string[] = report.files.map((file: { path: string }) => file.path);
  for (const expected of ['package.json', 'README.md', 'binding.js', 'binding.d.ts', 'dist/index.js']) {
    assert.ok(files.includes(expected), `${expected} is missing from ${files.join(', ')}`);
  }
  // Native binaries ship only in the platform packages. A local one would shadow them at load time.
  assert.deepEqual(
    files.filter(file => file.endsWith('.node')),
    [],
  );
  // The package is ESM only, the generated loader included.
  assert.deepEqual(
    files.filter(file => file.endsWith('.cjs') || file.endsWith('.cts')),
    [],
  );
});
