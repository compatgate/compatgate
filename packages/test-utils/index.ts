// The helpers of the tests of the compatgate packages: the paths of the system and temporary projects.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { after } from 'node:test';

/**
 * The absolute path of `segments` from the root of the system, for the tests that only pass paths around: `/p/a.ts`
 * on macOS and Linux, `D:\p\a.ts` on Windows. CI runs the tests on both, so each system checks its own paths. A
 * literal `/p/a.ts` would have no drive on Windows, where the core resolves `baseDir` to `D:\p` but takes a filename
 * as it is.
 */
export function fakePath(...segments: string[]): string {
  return resolve('/', ...segments);
}

/** The project of the tests that need one. */
export const FAKE_ROOT = fakePath('p');

/** `path` with `/` separators. Only the separator of the system changes: elsewhere `\` is a character of a name. */
export function toSlashes(path: string): string {
  return path.split(sep).join('/');
}

const projects: string[] = [];
// The projects go after the last test of the file, not in an `after` hook of their test. Those hooks run in the order
// of registration and stop at the first error, and Windows refuses to remove a directory that a watcher still holds:
// the removal would fail before the hook that closes the watcher, and the open watcher would keep the process alive.
after(() => {
  for (const root of projects) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Writes `files` into a new temporary directory and gives its real path. `prefix` names the directory, for paths
 * with special characters. The directory goes after the tests of the file.
 */
export function createProject(files: Record<string, string> = {}, prefix = 'compatgate-'): string {
  // The tools give real paths: macOS has a symlinked tmpdir, and Windows a short name such as `RUNNER~1` that only
  // `native` expands.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  projects.push(root);
  for (const [name, content] of Object.entries(files)) {
    writeFile(join(root, name), content);
  }
  return root;
}

/** Writes a file and the directories above it. */
export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Writes a file with a modification time `seconds` later: a test edits a file faster than the clock of the file
 * system ticks, and two writes in a row may get one time.
 */
export function editFile(path: string, content: string, seconds = 10): void {
  writeFile(path, content);
  const later = new Date(Date.now() + seconds * 1000);
  utimesSync(path, later, later);
}
