// Waits until npm serves the packages of the given directories, at the versions of their package.json. npm takes a
// tarball before its scan of the tarball ends, and an install fails until then: the core must not reach npm before
// its platform packages can be installed, and the check of the install must not start before the packages.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { isPublished } from './unpublished.js';

/** Asks npm for the missing packages until it serves all of them, `attempts` times at most. */
export async function waitForPackages(packages, { isPublished, sleep, attempts }) {
  let missing = packages;
  for (let attempt = 1; ; attempt += 1) {
    const served = await Promise.all(missing.map(({ name, version }) => isPublished(name, version)));
    missing = missing.filter((_, index) => !served[index]);
    if (missing.length === 0) {
      return;
    }
    const names = missing.map(({ name, version }) => `${name}@${version}`).join(', ');
    if (attempt === attempts) {
      throw new Error(`npm does not serve ${names} after ${attempts} attempts`);
    }
    console.log(`waiting for ${names}`);
    await sleep();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = process.argv.slice(2).map(directory => {
    const { name, version } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return { name, version };
  });
  // 20 minutes: a scan of npm took about 6 minutes for 0.1.0-next.0.
  await waitForPackages(packages, { isPublished, sleep: () => setTimeout(15_000), attempts: 80 });
  console.log(`npm serves ${packages.length} packages`);
}
