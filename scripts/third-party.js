// Writes packages/core/THIRD-PARTY-LICENSE from the crates of the binary. The release generates it before packing, so
// it always matches the published binary; the repository does not keep it.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = `${root}packages/core/THIRD-PARTY-LICENSE`;
const text = execFileSync(
  'cargo',
  // `--locked` reads no network beyond the crates of the lock file; `--fail` stops on a crate without a license.
  ['about', 'generate', '--locked', '--fail', '--manifest-path', `${root}packages/core/Cargo.toml`, `${root}about.hbs`],
  { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] },
);
writeFileSync(output, text);
