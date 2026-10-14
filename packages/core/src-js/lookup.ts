import { dirname, resolve } from 'node:path';

import { isInside } from './paths.ts';

// A `node_modules` segment of a path, with either separator. The lookahead keeps the next separator, so the
// matches of a nested path do not overlap.
const NODE_MODULES = /[\\/]node_modules(?=[\\/]|$)/g;

/**
 * The directory where the lookup of the configs for `filename` starts: the browserslist config and
 * compatgate.jsonc. A file inside `node_modules` belongs to a dependency, and the project builds it for its own
 * targets: the configs that the dependency ships do not apply. Its lookup starts in the directory above the
 * outermost `node_modules`, so a package of pnpm (`node_modules/.pnpm/x/node_modules/x`) takes the project
 * configs too. Any other file starts in its own directory.
 *
 * `root` is the project root. For a file inside the root, a `node_modules` segment that holds the root does not
 * count: a project that lies inside `node_modules` keeps its own configs. A file outside the root, such as a
 * dependency hoisted next to the project, counts every segment. Without `root` every segment counts.
 */
export function configLookupDirectory(filename: string, root?: string): string {
  const absolute = resolve(filename);
  const project = root === undefined ? undefined : resolve(root);
  const inside = project !== undefined && isInside(project, absolute);
  for (const match of absolute.matchAll(NODE_MODULES)) {
    const segment = absolute.slice(0, match.index + match[0].length);
    if (inside && isInside(segment, project)) {
      continue;
    }
    // The separator stays: `/node_modules/x` gives the root `/`, `C:\node_modules\x` gives `C:\`.
    return resolve(absolute.slice(0, match.index + 1));
  }
  return dirname(absolute);
}
