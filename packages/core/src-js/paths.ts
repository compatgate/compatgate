import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is the directory itself or lies below it. Both paths are absolute. */
export function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  // `..a.ts` is a file of the directory: only a whole `..` segment leaves it.
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** Whether `a` and `b` name one path: a trailing separator and, on Windows, the case and the separators may differ. */
export function samePath(a: string, b: string): boolean {
  return relative(a, b) === '';
}

/**
 * The name of a path in a message: relative to `baseDir` with `/` separators when it lies below it, as it is
 * otherwise. `/` on every system: a message reads the same everywhere. The root itself stays, as an empty name would
 * say nothing. One rule for every message of compatgate.
 */
export function displayPath(path: string, baseDir: string): string {
  const name = relative(baseDir, path);
  return name !== '' && isInside(baseDir, path) ? name.split(sep).join('/') : path;
}

/**
 * The paths of a message named by `displayPath`. The text may hold several paths, such as the chain of a circular
 * `extends`, and the text of browserslist.
 */
export function displayPaths(text: string, baseDir: string | undefined): string {
  if (baseDir === undefined) {
    return text;
  }
  // A path that starts at `baseDir`: `/p/a.ts` for `/p`, not `/q/p/a.ts` or `/pq/a.ts`. On Windows a tool gives either
  // separator and either case of the drive, so the start takes both. A path ends at a space.
  const windows = sep === '\\';
  const separator = windows ? '[\\\\/]' : '/';
  const segments = baseDir.split(windows ? /[\\/]/ : '/');
  while (segments.length > 1 && segments.at(-1) === '') {
    segments.pop();
  }
  const start = segments.map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(separator);
  const pattern = new RegExp(`(?<![\\w.\\-/\\\\])${start}${separator}\\S+`, windows ? 'gi' : 'g');
  return text.replace(pattern, path => displayPath(path, baseDir));
}
