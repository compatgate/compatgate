// The oxlint CLI for the tests that check the plugin in oxlint.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const manifest = createRequire(import.meta.url).resolve('oxlint/package.json');
// The script of the `bin` field, which Node runs on every system. Windows runs neither the shell script of
// node_modules/.bin nor, without a shell, the .cmd next to it.
const cli = join(dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.oxlint);

/** Runs oxlint with `args` in `cwd`. */
export function runOxlint(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}
