// Installs the published packages, or tarballs, into a copy of scripts/smoke and checks a finding in oxlint and
// rspack. The native package of the platform must work on its own: the checks run once with the wasm fallback moved
// away, and once more on the fallback alone when npm installed it.
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
const project = mkdtempSync(join(tmpdir(), 'compatgate-smoke-'));
cpSync(fileURLToPath(new URL('smoke', import.meta.url)), project, { recursive: true });
const tarballs = values.tarballs ? readdirSync(values.tarballs).filter(file => file.endsWith('.tgz')) : [];
const spec = name => {
  if (values.version) {
    return `${name}@${values.version}`;
  }
  // `compatgate-core-0.1.0.tgz`, not `compatgate-core-linux-x64-gnu-0.1.0.tgz`: the version follows the name.
  const base = name.replace('@', '').replace('/', '-');
  const file = tarballs.find(item => new RegExp(`^${base}-\\d`).test(item));
  if (!file) {
    throw new Error(`no tarball of ${name} in ${values.tarballs}`);
  }
  return resolve(values.tarballs, file);
};
// A tarball of the core does not bring its platform packages: install the platform tarballs too.
const platform = tarballs
  .filter(file => /^compatgate-core-[a-z]/.test(file))
  .map(file => resolve(values.tarballs, file));
execFileSync(
  windows ? 'npm.cmd' : 'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    spec('@compatgate/eslint'),
    spec('@compatgate/bundler'),
    spec('@compatgate/core'),
    ...platform,
    'oxlint@^1.87.0',
    '@rspack/core@^2.2.8',
  ],
  { cwd: project, stdio: 'inherit', shell: windows },
);

const scope = join(project, 'node_modules/@compatgate');
const installed = readdirSync(scope).filter(name => name.startsWith('core-'));
const native = installed.filter(name => name !== 'core-wasm32-wasi');
const failures = [];
if (native.length !== 1) {
  failures.push(`expected one native platform package, got: ${installed.join(', ') || 'none'}`);
}

function check(label, env = {}) {
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
}

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
if (failures.length > 0) {
  console.error(failures.join('\n\n'));
  process.exit(1);
}
console.log(`smoke ok: ${[...native, ...(hasWasm ? ['core-wasm32-wasi'] : [])].join(', ')} report api.structuredClone`);
