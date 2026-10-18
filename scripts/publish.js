// Packs the 12 packages of a release and publishes the tarballs. The two steps run in two jobs of release.yml: `pack`
// installs the dependencies and runs the code of the project without the OIDC token of npm, and `publish` holds the
// token and runs no code of the project or its dependencies. A malicious dependency cannot reach the token.
//
//   node scripts/publish.js pack <dir>      the tarballs and `manifest.json` into <dir>
//   node scripts/publish.js publish <dir>   the tarballs of <dir>, under the npm tag of NPM_CONFIG_TAG
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { isPublished } from './unpublished.js';
import { waitForPackages } from './wait-for-npm.js';

const PACKAGES = ['core', 'eslint', 'bundler'];

/** The file that `npm pack` and `pnpm pack` write for a package. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** Publishes `entries` in order and skips a version that npm already has, so a rerun publishes only the rest. */
export async function publishAll(entries, { isPublished, publish }) {
  for (const entry of entries) {
    if (!(await isPublished(entry.name, entry.version))) {
      publish(entry);
    }
  }
}

/** Packs the packages of `directories` with `tool` into `<root>/<group>` and gives their entries. */
function pack(root, group, tool, directories) {
  const destination = join(root, group);
  mkdirSync(destination, { recursive: true });
  return directories.map(directory => {
    const { name, version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    // pnpm puts the version of a workspace package in place of `workspace:^`.
    execFileSync(tool, ['pack', '--pack-destination', destination], { cwd: directory, stdio: 'inherit' });
    const file = join(group, tarballName(name, version));
    if (!existsSync(join(root, file))) {
      throw new Error(`${tool} pack wrote no ${file}`);
    }
    return { name, version, file };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, directory] = process.argv.slice(2);
  const root = resolve(directory ?? '');
  const packages = new URL('../packages/', import.meta.url);
  if (command === 'pack') {
    const npm = fileURLToPath(new URL('core/npm/', packages));
    const manifest = {
      // The platform packages first: the core lists them in its optionalDependencies.
      platforms: pack(
        root,
        'platforms',
        'npm',
        readdirSync(npm).map(name => join(npm, name)),
      ),
      packages: pack(
        root,
        'packages',
        'pnpm',
        PACKAGES.map(name => fileURLToPath(new URL(name, packages))),
      ),
    };
    writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } else if (command === 'publish') {
    const tag = process.env.NPM_CONFIG_TAG;
    if (!tag) {
      throw new Error('NPM_CONFIG_TAG names no npm tag');
    }
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
    for (const group of [manifest.platforms, manifest.packages]) {
      await publishAll(group, {
        isPublished,
        // `--ignore-scripts`: a tarball runs no lifecycle script here. npm adds the provenance under trusted
        // publishing.
        publish: entry =>
          execFileSync(
            'npm',
            ['publish', join(root, entry.file), '--access', 'public', '--ignore-scripts', '--tag', tag],
            {
              stdio: 'inherit',
            },
          ),
      });
      // npm serves a new version only after its scan of the tarball, minutes after the publish: an install of the core
      // before then finds no platform package. 20 minutes; a scan took about 6 for 0.1.0-next.0.
      await waitForPackages(group, { isPublished, sleep: () => setTimeout(15_000), attempts: 80 });
    }
  } else {
    throw new Error('usage: node scripts/publish.js pack|publish <dir>');
  }
}
