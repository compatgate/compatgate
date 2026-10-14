import { statSync } from 'node:fs';

/** The state of a file that tells an edit: `mtime:size`, or an empty string for a missing file. */
export function fileState(path: string): string {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats ? `${stats.mtimeMs}:${stats.size}` : '';
}
