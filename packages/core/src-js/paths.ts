import { isAbsolute, relative, sep } from 'node:path';

/** Whether `path` is the directory itself or lies below it. Both paths are absolute. */
export function isInside(directory: string, path: string): boolean {
  const rest = relative(directory, path);
  // `..a.ts` is a file of the directory: only a whole `..` segment leaves it.
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

/** The path in messages: relative to `baseDir` when it lies below it, the absolute path otherwise. */
export function displayPath(path: string, baseDir: string | undefined): string {
  if (baseDir === undefined) {
    return path;
  }
  const name = relative(baseDir, path);
  return name !== '' && isInside(baseDir, path) ? name : path;
}
