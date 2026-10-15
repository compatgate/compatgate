// Installs the packages of a release into a copy of scripts/smoke, as a user installs them: by name and version, from
// npmjs.com (`--version`) or from a local registry with the tarballs of a directory (`--tarballs`). It checks a finding
// in oxlint and rspack. The native package of the platform must work on its own: the checks run once with the wasm
// fallback moved away, and once more on the fallback alone when npm installed it.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { version: { type: 'string' }, tarballs: { type: 'string' } } });
if (!values.version === !values.tarballs) {
  throw new Error('pass --version <version> or --tarballs <directory>');
}
const windows = process.platform === 'win32';

let version = values.version;
let registry = 'https://registry.npmjs.org/';
let stop = () => {};
if (values.tarballs) {
  const directory = resolve(values.tarballs);
  const core = readdirSync(directory).find(file => /^compatgate-core-\d/.test(file));
  if (!core) {
    throw new Error(`no tarball of @compatgate/core in ${directory}`);
  }
  version = core.replace(/^compatgate-core-/, '').replace(/\.tgz$/, '');
  const { startRegistry } = await import('./local-registry.js');
  ({ url: registry, stop } = await startRegistry(directory));
}

const failures = [];
try {
  const project = mkdtempSync(join(tmpdir(), 'compatgate-smoke-'));
  cpSync(fileURLToPath(new URL('smoke', import.meta.url)), project, { recursive: true });
  // A fresh cache: a local registry serves the same version of a release that another check served before.
  const cache = mkdtempSync(join(tmpdir(), 'compatgate-npm-cache-'));
  execFileSync(
    windows ? 'npm.cmd' : 'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--registry',
      registry,
      '--cache',
      cache,
      `@compatgate/eslint@${version}`,
      `@compatgate/bundler@${version}`,
      'oxlint@^1.87.0',
      '@rspack/core@^2.2.8',
    ],
    { cwd: project, stdio: 'inherit', shell: windows },
  );

  const scope = join(project, 'node_modules/@compatgate');
  const installed = readdirSync(scope).filter(name => name.startsWith('core-'));
  const native = installed.filter(name => name !== 'core-wasm32-wasi');
  if (native.length !== 1) {
    failures.push(`expected one native platform package, got: ${installed.join(', ') || 'none'}`);
  }

  const check = (label, env = {}) => {
    const options = { cwd: project, encoding: 'utf8', env: { ...process.env, ...env } };
    // The config has no leading dot: oxlint in the repository would take a nested `.oxlintrc.json` as its own.
    const lint = spawnSync(windows ? 'npx.cmd' : 'npx', ['oxlint', '-c', 'oxlintrc.json', 'src'], {
      ...options,
      shell: windows,
    });
    if (lint.status !== 1 || !lint.stdout.includes('api.structuredClone')) {
      failures.push(`${label}: oxlint: exit ${lint.status}\n${lint.stdout}${lint.stderr}`);
    }
    const build = spawnSync(process.execPath, ['build.mjs'], options);
    if (build.status !== 0 || !build.stdout.includes('api.structuredClone')) {
      failures.push(`${label}: rspack: exit ${build.status}\n${build.stdout}${build.stderr}`);
    }
  };

  const wasm = join(scope, 'core-wasm32-wasi');
  const hasWasm = existsSync(wasm);
  if (hasWasm) {
    renameSync(wasm, `${wasm}.away`);
  }
  check(native[0] ?? 'native');
  if (hasWasm) {
    renameSync(`${wasm}.away`, wasm);
    check('core-wasm32-wasi', { NAPI_RS_FORCE_WASI: 'error' });
  }
  if (failures.length === 0) {
    const packages = [...native, ...(hasWasm ? ['core-wasm32-wasi'] : [])];
    console.log(`smoke ok: ${packages.join(', ')} report api.structuredClone`);
  }
} finally {
  stop();
}
if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
