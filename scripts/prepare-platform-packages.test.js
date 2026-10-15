import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preparePlatformPackages } from './prepare-platform-packages.js';

test('every platform package gets the licenses and lists them in files', t => {
  const npm = mkdtempSync(join(tmpdir(), 'compatgate-npm-'));
  t.after(() => rmSync(npm, { recursive: true, force: true }));
  const third = join(mkdtempSync(join(tmpdir(), 'compatgate-third-')), 'THIRD-PARTY-LICENSE');
  writeFileSync(third, 'crates');
  for (const name of ['darwin-arm64', 'wasm32-wasi']) {
    mkdirSync(join(npm, name));
    writeFileSync(
      join(npm, name, 'package.json'),
      JSON.stringify({ name: `@compatgate/core-${name}`, files: ['a.node'] }),
    );
  }
  preparePlatformPackages(npm, { thirdParty: third });
  for (const name of ['darwin-arm64', 'wasm32-wasi']) {
    for (const file of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD-PARTY-LICENSE']) {
      assert.ok(existsSync(join(npm, name, file)), `${name}/${file}`);
    }
    assert.equal(readFileSync(join(npm, name, 'THIRD-PARTY-LICENSE'), 'utf8'), 'crates');
    const pkg = JSON.parse(readFileSync(join(npm, name, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.files, ['a.node', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD-PARTY-LICENSE']);
  }
});

test('a second run lists each license once', t => {
  const npm = mkdtempSync(join(tmpdir(), 'compatgate-npm-'));
  t.after(() => rmSync(npm, { recursive: true, force: true }));
  const third = join(mkdtempSync(join(tmpdir(), 'compatgate-third-')), 'THIRD-PARTY-LICENSE');
  writeFileSync(third, 'crates');
  mkdirSync(join(npm, 'linux-x64-gnu'));
  writeFileSync(join(npm, 'linux-x64-gnu', 'package.json'), JSON.stringify({ files: ['a.node'] }));
  preparePlatformPackages(npm, { thirdParty: third });
  preparePlatformPackages(npm, { thirdParty: third });
  const pkg = JSON.parse(readFileSync(join(npm, 'linux-x64-gnu', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['a.node', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD-PARTY-LICENSE']);
});
