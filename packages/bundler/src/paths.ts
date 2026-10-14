import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is the directory itself or lies below it. Both paths are absolute. */
function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  // `..a.ts` is a file of the directory: only a whole `..` segment leaves it.
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/**
 * The path in messages: relative to `baseDir` when it lies below it, the absolute path otherwise. The messages of the
 * core name the configs the same way.
 */
export function displayPath(path: string, baseDir: string): string {
  const name = relative(baseDir, path);
  return name !== '' && isInside(baseDir, path) ? name : path;
}
