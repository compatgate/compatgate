import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is the directory itself or lies below it. Both paths are absolute. */
export function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  // `..a.ts` is a file of the directory: only a whole `..` segment leaves it.
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/**
 * The paths in a message: a path below `baseDir` relative to it, any other path as it is. One rule for every message
 * of the core: the advice of a finding, the problems of the entries and the errors of the configs. The text may hold
 * several paths, such as the chain of a circular `extends`, and the text of browserslist.
 */
export function displayPaths(text: string, baseDir: string | undefined): string {
  if (baseDir === undefined) {
    return text;
  }
  // Only a path that starts at `baseDir`: `/p/a.ts` for `/p`, not `/q/p/a.ts` or `/pq/a.ts`. The root itself stays,
  // as an empty name would say nothing.
  const prefix = `${baseDir.endsWith(sep) ? baseDir : baseDir + sep}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\w.\\-/\\\\])${prefix}(?=[^\\s])`, 'g'), '');
}
