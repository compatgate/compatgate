// Reads the corpus of the core, `crates/compatgate/tests/corpus`, and compares the findings of a tool with its
// expectations line by line. The format is in the README of the corpus; `tests/corpus.rs` reads it the same way.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AllowEntryInput, FindingConfidence } from '@compatgate/core';
import { parseSync, type ParserOptions } from 'oxc-parser';

export const CORPUS_DIR = fileURLToPath(new URL('../../crates/compatgate/tests/corpus', import.meta.url));
export const DEFAULT_TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

const TARGETS = '// targets:';
const FILENAME = '// filename:';
const ALLOW = '// allow:';
const EXPECT = '//~';
const EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const CONFIDENCES: readonly string[] = ['exact', 'heuristic', 'partial'];

export type SourceType = 'module' | 'commonjs';

/** An allow entry of the header: a feature id or an entry with the fields of the binding. */
export type HeaderAllowEntry = string | (AllowEntryInput & { baseDir?: string });

export interface CorpusFile {
  /** The path in the corpus, with `/`, such as `guards/model.js`. */
  name: string;
  source: string;
  targets: string;
  /** The filename that `check` gets: `// filename:` or the name. */
  filename: string;
  /** The entries of `// allow:` as written. A relative glob in `files` is relative to `baseDir`. */
  allow: HeaderAllowEntry[];
  /** How the linters parse the file, as the core does. */
  sourceType: SourceType;
  /** The normalized expectations by line number, from 1. */
  expectations: Map<number, Expectation>;
  /** The text of each line, without its terminator. */
  lines: string[];
}

export interface Expectation {
  /** The code before the `//~` comment. */
  code: string;
  /** The expectation in the form of `render`. */
  expected: string;
}

/** A finding as a tool reports it. */
export interface ToolFinding {
  /** From 1. */
  line: number;
  /** From 1, in UTF-16 code units, as in ESLint. */
  column: number;
  feature: string;
  confidence: FindingConfidence;
}

/** Every corpus file, sorted by name. */
export function readCorpus(): CorpusFile[] {
  return collect(CORPUS_DIR)
    .map(path => relative(CORPUS_DIR, path).split(sep).join('/'))
    .sort()
    .map(name => readCorpusFile(name, readFileSync(join(CORPUS_DIR, name), 'utf8')));
}

function collect(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return collect(path);
    }
    return EXTENSIONS.includes(extname(entry.name)) ? [path] : [];
  });
}

export function readCorpusFile(name: string, source: string): CorpusFile {
  const lines = splitLines(source);
  let targets = DEFAULT_TARGETS;
  let filename = name;
  let allow: HeaderAllowEntry[] = [];
  for (const line of lines) {
    const text = line.replace(/^\uFEFF/, '').trim();
    if (!text.startsWith('//')) {
      break;
    }
    if (text.startsWith(TARGETS)) {
      targets = text.slice(TARGETS.length).trim();
    } else if (text.startsWith(FILENAME)) {
      filename = text.slice(FILENAME.length).trim();
    } else if (text.startsWith(ALLOW)) {
      allow = allowEntries(name, text.slice(ALLOW.length));
    }
  }
  const { markers, sourceType } = parse(name, filename, source);
  const expectations = new Map<number, Expectation>();
  for (const [number, start] of markers) {
    const text = lines[number - 1] as string;
    expectations.set(number, {
      code: text.slice(0, start),
      expected: normalize(text.slice(start + EXPECT.length), `${name}:${number}`),
    });
  }
  if (expectations.size === 0) {
    throw new Error(`${name}: no \`${EXPECT}\` expectations`);
  }
  return { name, source, targets, filename, allow, sourceType, expectations, lines };
}

function allowEntries(name: string, json: string): HeaderAllowEntry[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) {
    throw new Error(`${name}: \`${ALLOW}\` is not a JSON array`);
  }
  return value as HeaderAllowEntry[];
}

/**
 * The lines of the source without their terminators, split as `check` counts lines: at `\n`, `\r\n`, a lone
 * `\r`, U+2028 and U+2029.
 */
export function splitLines(source: string): string[] {
  return source.split(/\r\n|[\n\r\u2028\u2029]/);
}

/**
 * The expectations, as the line number and the offset of `//~` in the line, and whether the file has module
 * syntax. An expectation is a line comment that starts with `//~`; the parser knows which `//~` is a comment.
 */
function parse(
  name: string,
  filename: string,
  source: string,
): { markers: Map<number, number>; sourceType: SourceType } {
  const extension = extname(filename).toLowerCase();
  // `check` parses JSX in plain JavaScript files too.
  const lang: ParserOptions['lang'] = ['.ts', '.mts', '.cts'].includes(extension)
    ? 'ts'
    : extension === '.tsx'
      ? 'tsx'
      : 'jsx';
  const sourceType = sourceTypeOf(
    extension,
    () => parseSync(filename, source, { lang, sourceType: 'unambiguous' }).module.hasModuleSyntax,
  );
  const parsed = parseSync(filename, source, { lang, sourceType });
  if (parsed.errors.length > 0) {
    throw new Error(
      `${name}: the file is not a valid program: ${parsed.errors.map(error => error.message).join('; ')}`,
    );
  }
  const starts = lineStarts(source);
  const markers = new Map<number, number>();
  for (const comment of parsed.comments) {
    if (comment.type === 'Line' && source.startsWith(EXPECT, comment.start)) {
      const line = starts.findLastIndex(start => start <= comment.start) + 1;
      markers.set(line, comment.start - (starts[line - 1] as number));
    }
  }
  return { markers, sourceType };
}

/**
 * `.mjs` and `.mts` are modules and `.cjs` and `.cts` CommonJS. Another file is a module when it has `import` or
 * `export`, else CommonJS: the core accepts `return` at the top level and sloppy mode code, such as `with`.
 */
function sourceTypeOf(extension: string, hasModuleSyntax: () => boolean): SourceType {
  if (['.mjs', '.mts'].includes(extension)) {
    return 'module';
  }
  if (['.cjs', '.cts'].includes(extension)) {
    return 'commonjs';
  }
  return hasModuleSyntax() ? 'module' : 'commonjs';
}

/** The UTF-16 offset of the start of each line. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    starts.push(match.index + match[0].length);
  }
  return starts;
}

/** The 1-based line and column, in UTF-16 code units, of a UTF-8 byte offset into the source. */
export function positionOfByte(source: string, offset: number): { line: number; column: number } {
  const before = Buffer.from(source, 'utf8').subarray(0, offset).toString('utf8');
  const lines = splitLines(before);
  return { line: lines.length, column: (lines.at(-1) as string).length + 1 };
}

/** The expectation in the form of `render`: items separated by `; `, words by one space. */
function normalize(expectation: string, where: string): string {
  const items = expectation
    .split(';')
    .map(item => item.split(/\s+/).filter(Boolean).join(' '))
    .filter(item => item !== '');
  if (items.length === 0) {
    throw new Error(`${where}: an empty expectation; write \`none\` for a line without findings`);
  }
  if (items.length === 1 && items[0] === 'none') {
    return 'none';
  }
  for (const item of items) {
    const words = item.split(' ');
    const confidence = words.at(-1) as string;
    const wellFormed =
      (words.length === 2 || (words.length === 3 && /^@\d+$/.test(words[0] as string))) &&
      CONFIDENCES.includes(confidence);
    if (!wellFormed) {
      throw new Error(`${where}: \`${item}\` is not \`[@column] feature confidence\``);
    }
  }
  return items.join('; ');
}

/**
 * The findings of one line in the order of the corpus: by column, then by feature. A finding gets its column when
 * the line has another finding of the same feature.
 */
export function render(findings: readonly ToolFinding[]): string {
  if (findings.length === 0) {
    return 'none';
  }
  return [...findings]
    .sort((a, b) => a.column - b.column || compareText(a.feature, b.feature))
    .map(finding => {
      const repeated = findings.filter(other => other.feature === finding.feature).length > 1;
      return repeated
        ? `@${finding.column} ${finding.feature} ${finding.confidence}`
        : `${finding.feature} ${finding.confidence}`;
    })
    .join('; ');
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The lines where the findings of a tool differ from the expectations, in the form of `tests/corpus.rs`:
 * the name and the line, the code, `-` the expectation and `+` the findings.
 */
export function differences(file: CorpusFile, findings: readonly ToolFinding[]): string[] {
  const byLine = new Map<number, ToolFinding[]>();
  for (const finding of findings) {
    byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
  }
  const numbers = [...new Set([...file.expectations.keys(), ...byLine.keys()])].sort((a, b) => a - b);
  const result: string[] = [];
  for (const number of numbers) {
    const expectation = file.expectations.get(number);
    const found = render(byLine.get(number) ?? []);
    if (expectation?.expected === found) {
      continue;
    }
    const code = expectation?.code ?? file.lines[number - 1] ?? '(past the end of the file)';
    result.push(
      `${file.name}:${number}\n    ${code.trim()}\n  - ${expectation?.expected ?? '(no `//~`)'}\n  + ${found}`,
    );
  }
  return result;
}

/** The number of lines with an expectation in the files. */
export function countCases(files: readonly CorpusFile[]): number {
  return files.reduce((count, file) => count + file.expectations.size, 0);
}

/**
 * The path of a corpus file in a copy of the corpus under `root`: its `// filename:` inside `root`. The linters
 * read files from the disk, so the copy puts each file where its header says.
 */
export function placedPath(root: string, file: CorpusFile): string {
  return join(root, file.filename);
}

/**
 * The allow entries of the header for a copy of the corpus under `root`. An entry without `baseDir` takes the
 * directory of the filename, as in `tests/corpus.rs`; every `baseDir` moves into `root`.
 */
export function placedAllow(root: string, file: CorpusFile): HeaderAllowEntry[] {
  const baseDir = dirname(placedPath(root, file));
  return file.allow.map(entry =>
    typeof entry === 'string'
      ? entry
      : { ...entry, baseDir: entry.baseDir === undefined ? baseDir : join(root, entry.baseDir) },
  );
}
