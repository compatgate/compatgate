import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import jsonc from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

import { ConfigError } from './errors.ts';
import { fileState } from './file-state.ts';
import { definitionOf, rulesOf, type SchemaNode } from './config-schema.ts';
import { checkOptions, isString, type OptionSchema } from './options.ts';
import { samePath } from './paths.ts';

export const ALLOW_FILE = 'compatgate.jsonc';

/**
 * Where an entry comes from. `own`: the `allow` of the project config or of the options.
 * `inherited`: the `extends` of a config or of the options. A report of unused entries covers own entries only.
 */
export type AllowOrigin = 'own' | 'inherited';

/**
 * Where an entry is written: the index in the `allow` list of a config file, or of the options of an adapter. `options`
 * is the name of the options in messages, such as `settings.compatgate`.
 */
export type AllowSource =
  | { readonly file: string; readonly index: number }
  | { readonly options: string; readonly index: number };

/**
 * An entry in the form that the core takes, plus its origin and source, which stay in JavaScript. compatgate sets
 * the origin and the source: an entry of the input has neither. Read only: the entries are cached and frozen.
 */
export interface AllowEntry {
  readonly feature: string;
  readonly packages: readonly string[];
  readonly files: readonly string[];
  /** Directory of the config file. `files` patterns are relative to it. */
  readonly baseDir: string;
  /**
   * `own`: the `allow` of the project config or of the options. `inherited`: the `extends` of a config or of the
   * options. A report of unused entries covers own entries only.
   */
  readonly origin: AllowOrigin;
  readonly source: AllowSource;
}

/** An entry as a user writes it: in `compatgate.jsonc` or inline in the options of an adapter. */
export interface AllowEntryInput {
  feature: string;
  packages?: string | readonly string[];
  files?: string | readonly string[];
  /** Directory that relative `files` patterns resolve against. Not accepted in `compatgate.jsonc`. */
  baseDir?: string;
}

export class AllowConfigError extends ConfigError {
  override name = 'AllowConfigError';
  readonly code = 'COMPATGATE_ALLOW';
  /**
   * The config file to fix: the file with the error, or the file whose `extends` names a missing file.
   * Absent for inline entries, the `extends` option and an error of the binding.
   */
  path: string | undefined;
}

/** A config file as compatgate.jsonc of a directory, and as a base of `extends`. */
export interface AllowFile {
  /** Tells the reads apart: a new read of an edited file gets a new id. */
  readonly id: number;
  /** The entries of the file as the config of its directory: its own entries, after the entries of its `extends`. */
  readonly entries: readonly AllowEntry[];
  /** The entries of the file as a base of `extends`: every entry is inherited. */
  readonly inherited: readonly AllowEntry[];
  /** Every file that the entries come from, the config and its `extends`, with its state before the read. */
  readonly files: ReadonlyMap<string, string>;
}

let reads = 0;

/** A number that no other list of entries has: the ids of the reads and of the inline lists. */
export function nextId(): number {
  reads += 1;
  return reads;
}

// The key is the absolute path of a config. configuration.ts watches the files of each entry and clears the cache
// when one of them changes.
const cache = new Map<string, AllowFile>();

export function clearAllowCache(): void {
  cache.clear();
}

/**
 * Finds compatgate.jsonc for the lookup directory `directory`: in it and above. `missing` holds the place in the
 * project root `root`, when the lookup passes the root without a file: a new file there would be found first.
 */
export function findAllowFile(directory: string, root?: string): { path: string | null; missing: string[] } {
  const missing: string[] = [];
  for (;;) {
    const candidate = join(directory, ALLOW_FILE);
    if (existsSync(candidate)) {
      return { path: candidate, missing };
    }
    if (root !== undefined && samePath(directory, root)) {
      missing.push(candidate);
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return { path: null, missing };
    }
    directory = parent;
  }
}

/** Reads a config with its `extends` once until `clearAllowCache`, so the entries keep their identity. */
export function readAllowFile(path: string): AllowFile {
  const cached = cache.get(path);
  if (cached) {
    return cached;
  }
  const files = new Map<string, string>();
  const entries = freeze(readConfig(path, [], files));
  const config: AllowFile = {
    id: nextId(),
    entries,
    inherited: freeze(entries.map(inherit)),
    files,
  };
  cache.set(path, config);
  return config;
}

/** The entries of the `allow` option of an adapter, with the name of the options in messages. */
export function inlineEntries(
  allow: ReadonlyArray<string | AllowEntryInput>,
  baseDir: string,
  where: string | undefined,
): readonly AllowEntry[] {
  const options = where ?? 'options';
  return freeze(
    allow.map((entry, index) => toEntry(entry, baseDir, `${options}.allow[${index}]`, { options, index }, true)),
  );
}

// Callers get the cached entries themselves: a change to one would show in every later load.
function freeze(entries: AllowEntry[]): readonly AllowEntry[] {
  for (const entry of entries) {
    Object.freeze(entry.packages);
    Object.freeze(entry.files);
    Object.freeze(entry.source);
    Object.freeze(entry);
  }
  return Object.freeze(entries);
}

function inherit(entry: AllowEntry): AllowEntry {
  return entry.origin === 'inherited' ? entry : { ...entry, origin: 'inherited' };
}

// `chain` holds the files of the current extends branch only. A file reached
// twice through different branches is valid; a file that extends itself is not.
// `files` collects the state of every file read, for the cache.
function readConfig(path: string, chain: readonly string[], files: Map<string, string>): AllowEntry[] {
  try {
    return readConfigFile(path, chain, files);
  } catch (error) {
    // The innermost file wins: an error in a file of `extends` names that file.
    if (error instanceof AllowConfigError && error.path === undefined) {
      error.path = path;
    }
    throw error;
  }
}

// A chain of `extends` is a few configs long. The reads of a chain go one call deeper for each config, and a chain of
// thousands, from a broken generator or on purpose in a dependency, would end the stack.
const MAX_EXTENDS = 100;

function readConfigFile(path: string, chain: readonly string[], files: Map<string, string>): AllowEntry[] {
  if (chain.includes(path)) {
    throw new AllowConfigError(`${path}: circular "extends": ${[...chain, path].join(' -> ')}`);
  }
  if (chain.length >= MAX_EXTENDS) {
    throw new AllowConfigError(`${path}: "extends" goes deeper than ${MAX_EXTENDS} configs`);
  }
  // The state is taken before the read: an edit between the two counts as a change at the next check.
  const state = fileState(path);
  if (state === '') {
    throw new AllowConfigError(`${path}: missing file`);
  }
  files.set(path, state);
  const errors: ParseError[] = [];
  const data: unknown = jsonc.parse(readText(path), errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error) {
    throw new AllowConfigError(`${path}: ${jsonc.printParseErrorCode(error.error)} at offset ${error.offset}`);
  }
  checkOptions(data, FILE_SCHEMA, path, { error: AllowConfigError, label: key => `${path}: "${key}"` });
  const fields = data as Readonly<Record<string, unknown>>;
  const nextChain = [...chain, path];
  const inherited = stringList(fields.extends).flatMap(target =>
    readConfig(resolveExtends(target, dirname(path), `${path}: "extends"`), nextChain, files).map(inherit),
  );
  const allow = (fields.allow ?? []) as unknown[];
  const own = allow.map((entry, index) =>
    toEntry(entry, dirname(path), `${path}: allow[${index}]`, { file: path, index }, false),
  );
  return [...inherited, ...own];
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    // The file may go away between the stat and the read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AllowConfigError(`${path}: missing file`);
    }
    throw error;
  }
}

/** `where` names the `extends` in error messages: of a config file (`<path>: "extends"`) or the option. */
export function resolveExtends(target: string, directory: string, where: string): string {
  if (target.startsWith('.') || isAbsolute(target)) {
    const path = resolve(directory, target);
    if (!existsSync(path)) {
      throw new AllowConfigError(`${where} points to a missing file: ${path}`);
    }
    return path;
  }
  // A package name means its compatgate.jsonc; a path that ends with .jsonc names a file inside the package.
  const request = target.endsWith('.jsonc') ? target : `${target}/${ALLOW_FILE}`;
  try {
    // createRequire takes a file; the name of a file that does not exist is enough to set the directory.
    return createRequire(join(directory, 'noop.js')).resolve(request);
  } catch {
    throw new AllowConfigError(
      `${where}: cannot resolve "${request}". The package is missing, or its "exports" hide the file`,
    );
  }
}

/**
 * Turns an entry as a user writes it into the form that the core takes. A feature id becomes an entry for any
 * file. Relative `files` patterns resolve against the `baseDir` of the entry, then against `baseDir`. `inline`: an
 * entry of the options, which may name its own `baseDir`; an entry of compatgate.jsonc may not. The origin is `own`:
 * the caller marks entries of `extends` as inherited.
 */
export function toEntry(
  value: unknown,
  baseDir: string,
  where: string,
  source: AllowSource,
  inline: boolean,
): AllowEntry {
  if (typeof value === 'string') {
    return { feature: value, packages: [], files: [], baseDir: resolve(baseDir), origin: 'own', source };
  }
  if (!isRecord(value) || typeof value.feature !== 'string') {
    throw new AllowConfigError(`${where}: expected a feature id or { "feature": string, "packages"?, "files"? }`);
  }
  checkOptions(value, inline ? INLINE_ENTRY_SCHEMA : ENTRY_SCHEMA, where, {
    error: AllowConfigError,
    hint: key =>
      key === 'origin' || key === 'source'
        ? `. compatgate sets the ${key} of an entry itself`
        : '. Write the reason as a comment',
  });
  return {
    feature: value.feature,
    packages: stringList(value.packages),
    files: stringList(value.files),
    // A relative directory would never match: linters and bundlers pass absolute filenames.
    baseDir: resolve((value.baseDir as string | undefined) ?? baseDir),
    origin: 'own',
    source,
  };
}

// The keys of compatgate.jsonc and of an entry come from the schema that editors use. `require` reads JSON without
// the warning that an import of a JSON module gives on some versions of Node of `engines`. The path is the same
// from `src-js` and from `dist`.
const SCHEMA = createRequire(import.meta.url)('../compatgate.schema.json') as SchemaNode;
const FILE_SCHEMA: OptionSchema = rulesOf(SCHEMA, SCHEMA);
const ENTRY_SCHEMA: OptionSchema = rulesOf(definitionOf(SCHEMA, 'entry'), SCHEMA);
// An entry of the options may name its own `baseDir`; an entry of compatgate.jsonc takes the directory of the file.
const INLINE_ENTRY_SCHEMA: OptionSchema = { ...ENTRY_SCHEMA, baseDir: [isString, 'a string'] };

/** A value that the schema allows as a string or a list of strings, as a list. */
function stringList(value: unknown): string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : (value as string[]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
