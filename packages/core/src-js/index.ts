import { loadAllow, loadAllowFile, toEntry, type AllowEntry, type AllowEntryInput } from './allow.ts';
import { binding } from './binding.ts';
import { LruCache } from './cache.ts';
import { resolveTargets } from './targets.ts';
import type { AllowIssue, CheckResult, Checker } from './types.ts';

export {
  ALLOW_FILE,
  AllowConfigError,
  clearAllowCache,
  findAllowFile,
  loadAllow,
  loadAllowFile,
  normalizeAllowEntry,
} from './allow.ts';
export type { AllowConfig, AllowEntry, AllowEntryInput } from './allow.ts';
export { TargetsConfigError, resolveTargets } from './targets.ts';
export type { ResolveTargetsOptions } from './targets.ts';
export type {
  AllowIssue,
  AllowIssueKind,
  CheckResult,
  Checker,
  ErrorCode,
  Finding,
  FindingConfidence,
  FindingKind,
  Gap,
  ParseError,
  ParseErrorKind,
  Position,
} from './types.ts';

export interface CheckerOptions {
  /** browserslist query. `resolveTargets` finds the query of a project. */
  targets: string;
  /** Feature ids and entries in the form of compatgate.jsonc. `loadAllow(...).entries` fits too. */
  allow?: ReadonlyArray<string | AllowEntryInput>;
  /** Directory that relative `files` patterns of `allow` resolve against. Default: the process directory. */
  baseDir?: string;
}

/**
 * Resolves the targets and compiles the `allow` entries once, for all files of a project.
 * Throws an error with the code `COMPATGATE_TARGETS` or `COMPATGATE_ALLOW`.
 */
export function createChecker(options: CheckerOptions): Checker {
  return new binding.Checker(options.targets, normalize(options.allow ?? [], options.baseDir));
}

function normalize(allow: ReadonlyArray<string | AllowEntryInput>, baseDir = process.cwd()): AllowEntry[] {
  return allow.map((entry, index) => toEntry(entry, baseDir, `allow[${index}]`, true));
}

export interface CheckOptions {
  /** Path of the checked file. Selects the parser and finds the configs. */
  filename: string;
  /** browserslist query. Default: the browserslist config of `filename`. */
  targets?: string;
  /** Query to use when the project has no browserslist config. */
  defaultTargets?: string;
  /** Allow entries. Default: compatgate.jsonc above `filename`. */
  allow?: ReadonlyArray<string | AllowEntryInput>;
  /** Path of the allow config, used when `allow` is not given. */
  allowFile?: string;
  /** Directory that relative `files` patterns of `allow` resolve against. Default: the process directory. */
  baseDir?: string;
}

/**
 * Checks one file. Finds the targets and compatgate.jsonc above `filename`, unless the options give them.
 * A linter or a bundler that checks many files should call `createChecker` once instead.
 */
export function check(source: string, options: CheckOptions): CheckResult {
  const targets = options.targets ?? resolveTargets(options.filename, { defaultTargets: options.defaultTargets });
  const allow = options.allow
    ? normalize(options.allow, options.baseDir)
    : (options.allowFile ? loadAllowFile(options.allowFile) : loadAllow(options.filename)).entries;
  return cachedChecker(targets, allow).check(source, options.filename);
}

// Resolving a query builds the support table of every feature, so `check` keeps the checkers of the
// recently used configurations. The key is the content: callers build new `allow` arrays for each call.
const checkers = new LruCache<string, Checker>(16);

function cachedChecker(targets: string, allow: AllowEntry[]): Checker {
  return checkers.get(JSON.stringify([targets, allow]), () => new binding.Checker(targets, allow));
}

/**
 * Whether a checker can parse a file with this name: JavaScript or TypeScript by the extension.
 * A bundler id with a query (`/src/a.ts?v=123`) is no file name: strip the query before the call.
 */
export function isCheckable(filename: string): boolean {
  return binding.isCheckable(filename);
}

export function validateAllow(
  allow: ReadonlyArray<string | AllowEntryInput>,
  targets: string,
  baseDir?: string,
): AllowIssue[] {
  return binding.validateAllow(normalize(allow, baseDir), targets);
}

export function bcdVersion(): string {
  return binding.bcdVersion();
}
