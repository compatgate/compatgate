import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import jsonc from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

export const ALLOW_FILE = 'compatgate.jsonc';

export interface AllowEntry {
  feature: string;
  packages: string[];
  files: string[];
  /** Directory of the config file. `files` patterns are relative to it. */
  baseDir: string;
}

export interface AllowConfig {
  path: string | null;
  entries: AllowEntry[];
}

export class AllowConfigError extends Error {
  override name = 'AllowConfigError';
}

const cache = new Map<string, AllowConfig>();

export function clearAllowCache(): void {
  cache.clear();
}

export function findAllowFile(filename: string): string | null {
  let directory = dirname(resolve(filename));
  for (;;) {
    const candidate = join(directory, ALLOW_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

/** Loads the config that applies to `filename`. The result is cached per directory. */
export function loadAllow(filename: string): AllowConfig {
  const directory = dirname(resolve(filename));
  const cached = cache.get(directory);
  if (cached) {
    return cached;
  }
  const path = findAllowFile(filename);
  const config: AllowConfig = path ? { path, entries: readConfig(path, []) } : { path: null, entries: [] };
  cache.set(directory, config);
  return config;
}

export function loadAllowFile(path: string): AllowConfig {
  const absolute = resolve(path);
  return { path: absolute, entries: readConfig(absolute, []) };
}

// `chain` holds the files of the current extends branch only. A file reached
// twice through different branches is valid; a file that extends itself is not.
function readConfig(path: string, chain: readonly string[]): AllowEntry[] {
  if (chain.includes(path)) {
    throw new AllowConfigError(`${path}: circular "extends": ${[...chain, path].join(' -> ')}`);
  }
  const errors: ParseError[] = [];
  const data: unknown = jsonc.parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  const [error] = errors;
  if (error) {
    throw new AllowConfigError(`${path}: ${jsonc.printParseErrorCode(error.error)} at offset ${error.offset}`);
  }
  if (!isRecord(data)) {
    throw new AllowConfigError(`${path}: expected an object`);
  }
  for (const key of Object.keys(data)) {
    if (key !== 'extends' && key !== 'allow') {
      throw new AllowConfigError(`${path}: unknown key "${key}"`);
    }
  }
  const nextChain = [...chain, path];
  const inherited = stringList(data.extends, `${path}: "extends"`).flatMap(target =>
    readConfig(resolveExtends(target, path), nextChain),
  );
  const allow = data.allow ?? [];
  if (!Array.isArray(allow)) {
    throw new AllowConfigError(`${path}: "allow" must be an array`);
  }
  const own = allow.map((entry, index) => toEntry(entry, dirname(path), `${path}: allow[${index}]`));
  return [...inherited, ...own];
}

function resolveExtends(target: string, from: string): string {
  if (target.startsWith('.') || isAbsolute(target)) {
    const path = resolve(dirname(from), target);
    if (!existsSync(path)) {
      throw new AllowConfigError(`${from}: "extends" points to a missing file: ${path}`);
    }
    return path;
  }
  // A package name means its compatgate.jsonc; a path that ends with .jsonc names a file inside the package.
  const request = target.endsWith('.jsonc') ? target : `${target}/${ALLOW_FILE}`;
  try {
    return createRequire(from).resolve(request);
  } catch {
    throw new AllowConfigError(
      `${from}: cannot resolve "extends": "${request}". The package is missing, or its "exports" hide the file`,
    );
  }
}

function toEntry(value: unknown, baseDir: string, where: string): AllowEntry {
  if (typeof value === 'string') {
    return { feature: value, packages: [], files: [], baseDir };
  }
  if (!isRecord(value) || typeof value.feature !== 'string') {
    throw new AllowConfigError(`${where}: expected a feature id or { "feature": string, "packages"?, "files"? }`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'feature' && key !== 'packages' && key !== 'files') {
      throw new AllowConfigError(`${where}: unknown key "${key}". Write the reason as a comment`);
    }
  }
  return {
    feature: value.feature,
    packages: stringList(value.packages, `${where}.packages`),
    files: stringList(value.files, `${where}.files`),
    baseDir,
  };
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) {
    return [];
  }
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string')) {
    throw new AllowConfigError(`${where}: expected a string or an array of strings`);
  }
  return list;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
