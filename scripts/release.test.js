import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export const PUBLISHED = ['core', 'eslint', 'bundler'];
export const readPackage = name => JSON.parse(readFileSync(`${root}packages/${name}/package.json`, 'utf8'));

test('the root has both license texts', () => {
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
    assert.ok(existsSync(`${root}${file}`), file);
  }
  assert.match(readFileSync(`${root}LICENSE-MIT`, 'utf8'), /^MIT License/);
  assert.match(readFileSync(`${root}LICENSE-APACHE`, 'utf8'), /Apache License\s+Version 2\.0/);
});

test('every published package has the metadata of npm', () => {
  for (const name of PUBLISHED) {
    const pkg = readPackage(name);
    assert.equal(pkg.license, 'MIT OR Apache-2.0', name);
    assert.deepEqual(
      pkg.repository,
      { type: 'git', url: 'git+https://github.com/compatgate/compatgate.git', directory: `packages/${name}` },
      name,
    );
    assert.equal(pkg.homepage, `https://github.com/compatgate/compatgate/tree/main/packages/${name}#readme`, name);
    assert.deepEqual(pkg.bugs, { url: 'https://github.com/compatgate/compatgate/issues' }, name);
    assert.equal(pkg.author, 'Shamil Iakupov <me@shamil.tech>', name);
    assert.deepEqual(pkg.publishConfig, { access: 'public' }, name);
    assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('browserslist'), name);
    assert.ok(pkg.files.includes('LICENSE-MIT') && pkg.files.includes('LICENSE-APACHE'), name);
    assert.equal(pkg.scripts.prepack, 'node ../../scripts/copy-licenses.js', name);
  }
});
