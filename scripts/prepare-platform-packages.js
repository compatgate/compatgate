// The platform packages of `napi create-npm-dirs` carry the binary, so they carry its licenses too.
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Copies the licenses into each package of `npmDir` and lists them in its `files`. */
export function preparePlatformPackages(npmDir, { thirdParty = `${root}packages/core/THIRD-PARTY-LICENSE` } = {}) {
  const licenses = [
    ['LICENSE-MIT', `${root}LICENSE-MIT`],
    ['LICENSE-APACHE', `${root}LICENSE-APACHE`],
    ['THIRD-PARTY-LICENSE', thirdParty],
  ];
  for (const name of readdirSync(npmDir)) {
    const dir = join(npmDir, name);
    const manifest = join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [file, source] of licenses) {
      copyFileSync(source, join(dir, file));
      if (!pkg.files.includes(file)) {
        pkg.files.push(file);
      }
    }
    writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  preparePlatformPackages(process.argv[2] ?? `${root}packages/core/npm`);
}
