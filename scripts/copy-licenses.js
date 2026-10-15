// npm takes the license files from the directory of a package only: `prepack` copies the root ones there.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) {
  copyFileSync(`${root}${file}`, `${process.cwd()}/${file}`);
}
