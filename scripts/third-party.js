// Writes packages/core/THIRD-PARTY-LICENSE from the crates of the binary. The release generates it before packing, so
// it always matches the published binary; the repository does not keep it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// `-o` instead of the standard output: cargo-about refuses a redirected output under PowerShell, the Windows shell of
// CI. `--locked` reads no network beyond the crates of the lock file; `--fail` stops on a crate without a license.
execFileSync(
  'cargo',
  [
    'about',
    'generate',
    '--locked',
    '--fail',
    '--manifest-path',
    `${root}packages/core/Cargo.toml`,
    '-o',
    `${root}packages/core/THIRD-PARTY-LICENSE`,
    `${root}about.hbs`,
  ],
  { cwd: root, stdio: 'inherit' },
);
