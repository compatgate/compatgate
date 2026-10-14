import { readFileSync } from 'node:fs';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Position } from '@compatgate/core';
import {
  TraceMap,
  originalPositionFor,
  sourceContentFor,
  traceSegment,
  type SourceMapInput,
} from '@jridgewell/trace-mapping';

import type { ModuleFile } from './module-id.ts';

/** The place of a finding in a source file. */
export interface SourcePosition extends Position {
  path: string;
}

/** The checked code and the range of a finding in it, UTF-16 offsets as in `Finding.range`. */
export interface FindingText {
  code: string;
  range: readonly [number, number];
}

/**
 * Gives the place of a finding in the source, or `null` when the bundler gives no way from the checked code back
 * to the source. The message then shows the position in the checked code.
 */
export type Locate = (start: Position, text?: FindingText) => SourcePosition | null;

/**
 * Maps the positions of a module through its source map. `map` gives the map from the source to the checked
 * code; it is called once, on the first finding, because a bundler combines the maps of all its plugins for it.
 */
export function sourceMapLocate(file: ModuleFile, map: () => unknown): Locate {
  let traced: TraceMap | null | undefined;
  const files = new Map<string, boolean>();
  const lines = new Map<string, readonly string[] | null>();
  const copied = copiedColumns();
  return (start, text) => {
    traced ??= traceMap(map);
    if (traced === null) {
      return null;
    }
    const original = originalPositionFor(traced, start);
    if (original.line === null || original.source === null) {
      return null;
    }
    const path = sourcePath(original.source, file.path);
    if (path === null) {
      return null;
    }
    let matches = files.get(path);
    if (matches === undefined) {
      matches = sameText(path, sourceContentFor(traced, original.source));
      files.set(path, matches);
    }
    if (!matches) {
      return null;
    }
    const segment = traceSegment(traced, start.line - 1, start.column);
    let column = original.column;
    if (segment && text) {
      let source = lines.get(path);
      if (source === undefined) {
        source = sourceLines(path, sourceContentFor(traced, original.source));
        lines.set(path, source);
      }
      const at = { line: start.line - 1, generated: segment[0], original: original.column };
      column = copied(at, start.column, text, source?.[original.line - 1]) ?? column;
    }
    return { path, line: original.line, column };
  };
}

/** A segment of a map: its generated line from 0, and its generated and original columns. */
export interface Segment {
  line: number;
  generated: number;
  original: number;
}

/**
 * Gives the original column of a finding inside a segment of a map, or `null` when it has no sure one. A syntax
 * finding starts at the token of the feature, which can lie inside a segment: `(?<=` inside a regular expression
 * literal, `??` in the segment of its left operand. The finding keeps its offset in the segment only when the
 * generated text from the start of the segment through the token is a copy of the original line: a transform may
 * drop text inside a segment, such as a comment or `as T` before `??`. `line` is the original line.
 */
export type CopiedColumn = (
  segment: Segment,
  column: number,
  text: FindingText,
  line: string | undefined,
) => number | null;

/**
 * A `CopiedColumn` that measures the copied run of each segment once, and only as far as a finding needs: a long
 * line of a bundle may be one segment, and a comparison of the whole prefix for each finding would cost the length
 * of the line per finding. The function holds the runs, so one function serves one generated text and one map.
 */
export function copiedColumns(): CopiedColumn {
  /** The UTF-16 units of each segment that are a copy, and whether the copy ends there. */
  const runs = new Map<string, { length: number; ended: boolean }>();
  return (segment, column, text, line) => {
    const offset = column - segment.generated;
    if (offset < 0 || line === undefined) {
      return null;
    }
    const [start, end] = text.range;
    const needed = offset + end - start;
    const key = `${segment.line}:${segment.generated}`;
    let run = runs.get(key);
    if (!run) {
      run = { length: 0, ended: false };
      runs.set(key, run);
    }
    // The offset of the start of the segment in the generated text.
    const from = start - offset;
    while (!run.ended && run.length < needed) {
      const generated = from + run.length;
      const original = segment.original + run.length;
      if (
        generated < text.code.length &&
        original < line.length &&
        text.code.charCodeAt(generated) === line.charCodeAt(original)
      ) {
        run.length += 1;
      } else {
        run.ended = true;
      }
    }
    return needed <= run.length ? segment.original + offset : null;
  };
}

/** The lines of a text, split as the core counts them. */
export function textLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/);
}

/** The lines of a source: the text that its map keeps, else the file. `null` when neither is there. */
function sourceLines(path: string, content: string | null): readonly string[] | null {
  try {
    return textLines(content ?? readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// A map can end at the code of a `load` hook instead of the file: plugin-vue loads the script of a component
// so when the build makes no source maps. Its source then names the component, but its lines are other lines.
// The map keeps the text of its source, and the text tells the two apart.
function sameText(path: string, content: string | null): boolean {
  if (content === null) {
    return true;
  }
  // A loader may drop the byte order mark of the file.
  const text = (value: string) => value.replace(/^﻿/, '');
  try {
    return text(readFileSync(path, 'utf8')) === text(content);
  } catch {
    return false;
  }
}

/** The map that `map` gives, or `null` when it gives none or a broken one. */
export function traceMap(map: () => unknown): TraceMap | null {
  try {
    // A loader of webpack may give the map as its JSON text.
    const given = map();
    const value = (typeof given === 'string' ? JSON.parse(given) : given) as { mappings?: unknown } | null | undefined;
    return typeof value?.mappings === 'string' ? new TraceMap(value as SourceMapInput) : null;
  } catch {
    // A plugin may give a broken map. The position in the checked code is still of use.
    return null;
  }
}

// A source of a map is a file path, a `file:` URL or a path relative to the module. Vite names the script of a
// component with its query, such as `App.vue?vue&type=script&setup=true&lang.ts`.
function sourcePath(source: string, modulePath: string): string | null {
  let path = source.replace(/\?.*$/, '');
  if (path.startsWith('file:')) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }
  if (path === '' || path.startsWith('\0') || /^[a-z][\w+.-]+:/i.test(path)) {
    return null;
  }
  return win32.isAbsolute(path) ? path : resolve(dirname(modulePath), path);
}
