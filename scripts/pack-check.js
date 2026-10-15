// Packs the published packages as npm would and checks the files of each tarball: a missing file breaks an install,
// an extra one, such as a local binary, overrides the platform package.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMON = ['package.json', 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE', 'dist/index.js', 'dist/index.d.ts'];
const REQUIRED = {
  core: [...COMMON, 'binding.js', 'binding.d.ts', 'THIRD-PARTY-LICENSE'],
  eslint: COMMON,
  bundler: [
    ...COMMON,
    'dist/vite.js',
    'dist/webpack.js',
    'dist/rspack.js',
    'dist/rollup.js',
    'dist/rolldown.js',
    'dist/esbuild.js',
  ],
};
const ALLOWED = [
  /^dist\/.+\.(js|d\.ts)$/,
  /^docs\/.+\.md$/,
  /^(package\.json|README\.md|CHANGELOG\.md|LICENSE-MIT|LICENSE-APACHE)$/,
];
const CORE_ALLOWED = /^(binding\.js|binding\.d\.ts|THIRD-PARTY-LICENSE)$/;

/** The errors of the file list of a tarball: missing required files first, in the order of `REQUIRED`. */
export function checkFiles(name, files) {
  const errors = REQUIRED[name].filter(file => !files.includes(file)).map(file => `${name}: missing ${file}`);
  for (const file of files) {
    if (!ALLOWED.some(pattern => pattern.test(file)) && !(name === 'core' && CORE_ALLOWED.test(file))) {
      errors.push(`${name}: unexpected ${file}`);
    }
  }
  return errors;
}

function pack(name, directory) {
  const output = execFileSync('pnpm', ['pack', '--json', '--pack-destination', directory], {
    cwd: fileURLToPath(new URL(`../packages/${name}`, import.meta.url)),
    encoding: 'utf8',
  });
  return JSON.parse(output).files.map(file => file.path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'compatgate-pack-')));
  const errors = ['core', 'eslint', 'bundler'].flatMap(name => checkFiles(name, pack(name, directory)));
  if (process.argv[2] === undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
}
