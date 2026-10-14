import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  ALLOW_FILE,
  AllowConfigError,
  clearAllowCache,
  findAllowFile,
  inlineEntries,
  nextId,
  readAllowFile,
  resolveExtends,
  type AllowEntry,
  type AllowFile,
} from './allow.ts';
import { binding } from './binding.ts';
import { LruCache } from './cache.ts';
import { describeAllowIssue, describeFinding, type DescribeFindingOptions } from './describe.ts';
import { ConfigError } from './errors.ts';
import { fileState } from './file-state.ts';
import { configLookupDirectory } from './lookup.ts';
import { readConfigurationOptions, type SharedOptions } from './options.ts';
import { TARGETS_FILES, TargetsConfigError, clearTargetsCache, resolveBrowsers, resolveTargetsIn } from './targets.ts';
import type { AllowIssue, CheckResult, Checker, CoreAllowIssue, CoreChecker, Finding } from './types.ts';

export interface ResolverOptions extends SharedOptions {
  /**
   * Directory that `extends` and relative `files` patterns of `allow` resolve against, and the project root of the
   * lookup of the configs: a `node_modules` directory that holds it does not count as a dependency. Default: the
   * process directory.
   */
  baseDir?: string;
  /**
   * The name of the options in messages, such as `settings.compatgate`: `settings.compatgate.allow[0]`. An entry of
   * `allow` names it in its `source`. Default: `options`.
   */
  where?: string;
}

export interface ResolveOptions {
  /**
   * A token of one build. The first call with a token checks the configs; the other calls with it do not. A bundler
   * passes a new object at the start of each build. Without it, a call checks the configs at most once in 250 ms, as
   * a linter in an IDE needs. The calls of one resolver with one token read the variables of browserslist once.
   */
  snapshot?: object;
}

/** How to check the files of one directory. Frozen: the same object serves many files. */
export interface Configuration {
  /** The browserslist query: the queries of the config as written, the option or the default query. */
  readonly targets: string;
  /** The entries of `extends`, then the entries of `allow` or of compatgate.jsonc. `suppressed` indexes them. */
  readonly entries: readonly AllowEntry[];
  /** The checker of the targets and the entries. Directories with the same configs share it. */
  readonly checker: Checker;
  /** The entries with an unknown feature id and the entries that every target supports. */
  readonly issues: readonly AllowIssue[];
  /** browserslist names in the targets that compatgate has no data for. */
  readonly ignoredBrowsers: readonly string[];
  /** The configs that the configuration comes from: an edit of one changes it. */
  readonly watch: readonly string[];
  /**
   * The places of a new config in the project root that would apply instead of a found one or conflict with it:
   * .browserslistrc, browserslist, package.json and compatgate.jsonc. A new config in another directory applies after
   * `clearCaches` or a restart.
   */
  readonly missing: readonly string[];
}

/** Gives the configurations of the files for one set of options. */
export interface Resolver {
  /**
   * Gives the configuration of `filename`: the targets, the `allow` entries and their checker. The configuration
   * depends on the directory where the lookup of the configs starts, not on the file, and is cached for the
   * directory. A directory without configs takes the configuration of its parent. A change of a file of `watch` or
   * `missing` of any configuration or error drops every cached configuration; without `snapshot` the files are
   * checked at most once in 250 ms. Throws a `ConfigError`: `TargetsConfigError` or `AllowConfigError`. Its `watch`
   * and `missing` name the configs whose fix starts a new check.
   */
  resolve(filename: string, options?: ResolveOptions): Configuration;
  /**
   * Checks one file with the checker of `resolve(filename, options)`. The indexes of `suppressed` point into the
   * `entries` of that configuration. `parseAs` is a name whose extension selects the parser instead of `filename`,
   * such as `/src/App.vue.ts` for the script of `/src/App.vue`.
   */
  check(source: string, filename: string, options?: CheckOptions): CheckResult;
}

export interface CheckOptions extends ResolveOptions {
  /** A name whose extension selects the parser instead of `filename`. */
  parseAs?: string;
}

/**
 * Checks the options and gives the resolver of the configurations. An adapter makes it when it reads its options,
 * so that an option of a wrong type fails at once, not at the first file. Throws `OptionsError`.
 */
export function createResolver(options: ResolverOptions = {}): Resolver {
  const shared = readConfigurationOptions(options as Readonly<Record<string, unknown>>, options.where ?? 'options');
  const checked: ResolverOptions = Object.freeze({ ...shared, baseDir: options.baseDir, where: options.where });
  const resolve = (filename: string, { snapshot }: ResolveOptions = {}) =>
    resolveConfiguration(filename, checked, snapshot);
  return Object.freeze({
    resolve,
    check: (source: string, filename: string, { parseAs, snapshot }: CheckOptions = {}) =>
      resolve(filename, { snapshot }).checker.check(source, filename, parseAs),
  });
}

/**
 * @internal — tests only. `computations` counts the full computations of a configuration, `lookups` the lookups of
 * the directory where the lookup of the configs of a file starts, `scopes` the reads of the options, `checks` the
 * checks of the watched configs.
 */
export const counters = { computations: 0, lookups: 0, scopes: 0, checks: 0 };

/** @internal — tests only. The clock of the checks without a snapshot, in milliseconds. */
export const clock = { now: (): number => performance.now() };

// Without a snapshot a call checks the configs at most once in this time. A linter run checks them a few times
// instead of once per file, and an edit in an IDE shows sooner than a person looks.
const CHECK_INTERVAL = 250;

// Every config of the configurations and of the errors since the last reset, and every place of a new config in the
// project root, with its state when read: see `fileState`. One set serves every set of options: a change of any file
// resets every cache, as the caches of browserslist and of compatgate.jsonc serve every set of options too. A file
// keeps the state of its first read, so a change after that read counts even when a later read sees it.
const watched = new Map<string, string>();
let checkedAt = Number.NEGATIVE_INFINITY;
const checkedSnapshots = new WeakSet<object>();

/** The configurations of one set of options. */
interface Scope {
  readonly options: ResolverOptions;
  /** The absolute project root. */
  readonly baseDir: string;
  /** The names of the configs that make a directory compute its own configuration. */
  readonly names: readonly string[];
  readonly bases: readonly string[];
  readonly inline: { readonly id: number; readonly entries: readonly AllowEntry[] } | undefined;
  readonly directories: Map<string, Configuration>;
  /** The directory where the lookup starts, by the directory of an absolute file name. */
  readonly lookups: Map<string, string>;
}

// The key is the content of the options: an adapter builds new options for each file. A linter in an IDE or a
// monorepo with several configs of the linter has a few sets of options; the cache keeps the recent ones.
const scopes = new LruCache<string, Scope>(16);

// The list of entries of each combination of reads, so that one combination keeps one list. The key holds the ids
// of the reads: an edited file gets a new id. The cache keeps the recent lists: an old list goes with its checker
// once no configuration holds it, so the edits of a config in an IDE do not pile up checkers.
const lists = new LruCache<string, readonly AllowEntry[]>(64);

interface Compiled {
  readonly checker: CoreChecker;
  readonly issues: readonly CoreAllowIssue[];
  readonly ignoredBrowsers: readonly string[];
}

// The checkers by the identity of the list of entries, then by the browsers of the targets. A list lives while a
// configuration holds it, and so does its checker. Each list keeps the checkers of a few recent targets: an edit of
// the browserslist config or another environment gives new targets, and a checker holds a support table.
let checkers = new WeakMap<readonly AllowEntry[], LruCache<string, Compiled>>();
const TARGETS_PER_LIST = 4;

/** @internal — tests only. The number of targets that keep a checker for the list. */
export function compiledTargets(entries: readonly AllowEntry[]): number {
  return checkers.get(entries)?.size ?? 0;
}

/**
 * The directories that one map of a set of options keeps: a scope has two maps, the configurations and the
 * lookup directories, and up to 16 scopes stay. A linter in an IDE opens files across a large tree for hours;
 * past the limit the map starts again, and the configs give the same configurations. A build of a real service
 * has 4 326 lookup directories and more of their parents: a smaller limit drops the cache in each build.
 */
export const DIRECTORY_LIMIT = 65_536;

/** @internal — tests only. The number of cached directories of every set of options. */
export function cachedDirectories(): { configurations: number; lookups: number } {
  const count = { configurations: 0, lookups: 0 };
  for (const scope of scopes.values()) {
    count.configurations += scope.directories.size;
    count.lookups += scope.lookups.size;
  }
  return count;
}

// The scope of the options object of the last call with each snapshot. A bundler passes one object for the calls of
// a build, and the key of the options costs as much as the rest of a cached call.
let snapshotScopes = new WeakMap<object, { readonly options: ResolverOptions; readonly scope: Scope }>();

/** Drops every cached configuration, config and checker, and the caches of browserslist. */
export function clearCaches(): void {
  scopes.clear();
  snapshotScopes = new WeakMap();
  lists.clear();
  checkers = new WeakMap();
  messaging = new WeakMap();
  clearAllowCache();
  clearTargetsCache();
  watched.clear();
}

// Stats the watched files: a change of any of them drops every cache, and the next calls compute again.
function check(snapshot: object | undefined): void {
  if (snapshot === undefined) {
    const now = clock.now();
    if (now - checkedAt < CHECK_INTERVAL) {
      return;
    }
    checkedAt = now;
  } else if (checkedSnapshots.has(snapshot)) {
    return;
  } else {
    checkedSnapshots.add(snapshot);
  }
  counters.checks += 1;
  for (const [path, state] of watched) {
    if (fileState(path) !== state) {
      clearCaches();
      return;
    }
  }
}

function track(watch: Iterable<readonly [string, string]>, missing: Iterable<string>): void {
  for (const [path, state] of watch) {
    if (!watched.has(path)) {
      watched.set(path, state);
    }
  }
  for (const path of missing) {
    if (!watched.has(path)) {
      watched.set(path, '');
    }
  }
}

// `Resolver.resolve`: `options` are checked already.
function resolveConfiguration(filename: string, options: ResolverOptions, snapshot: object | undefined): Configuration {
  let directory: string | undefined;
  check(snapshot);
  try {
    const scope = scopeOf(options, snapshot);
    directory = lookupDirectory(scope, filename);
    return resolveDirectory(scope, directory);
  } catch (error) {
    // `compute` has set `watch` and `missing` of an error of the binding: `watchFailure` would narrow them to one file.
    if (!watchedErrors.has(error as object)) {
      directory ??= configLookupDirectory(filename, resolve(options.baseDir ?? process.cwd()));
      watchFailure(error, options, directory);
    }
    throw error;
  }
}

function scopeOf(options: ResolverOptions, snapshot: object | undefined): Scope {
  const last = snapshot === undefined ? undefined : snapshotScopes.get(snapshot);
  if (last?.options === options) {
    return last.scope;
  }
  counters.scopes += 1;
  const baseDir = resolve(options.baseDir ?? process.cwd());
  const scope = scopes.get(scopeKey(options, baseDir), () => createScope(options, baseDir));
  if (snapshot !== undefined) {
    snapshotScopes.set(snapshot, { options, scope });
  }
  return scope;
}

// The files of a directory share the directory where the lookup starts. Its computation resolves the paths and
// costs more than the rest of a cached call. A relative name depends on the process directory and is not cached.
function lookupDirectory(scope: Scope, filename: string): string {
  // The last segment of these names counts in the lookup: a file named `node_modules` is a segment of the path,
  // and `.` or `..` moves the directory. Such a name and its siblings have other directories.
  const cached = isAbsolute(filename) && !/[\\/](?:node_modules|\.\.?)$/.test(filename);
  const parent = dirname(filename);
  let directory = cached ? scope.lookups.get(parent) : undefined;
  if (directory === undefined) {
    counters.lookups += 1;
    directory = configLookupDirectory(filename, scope.baseDir);
    if (cached) {
      if (scope.lookups.size >= DIRECTORY_LIMIT) {
        scope.lookups.clear();
      }
      scope.lookups.set(parent, directory);
    }
  }
  return directory;
}

function scopeKey(options: ResolverOptions, baseDir: string): string {
  const { env } = process;
  return JSON.stringify([
    options.targets,
    options.defaultTargets,
    options.allow,
    options.extends,
    options.where,
    baseDir,
    // The variables of browserslist change the targets of every directory.
    env.BROWSERSLIST,
    env.BROWSERSLIST_CONFIG,
    env.BROWSERSLIST_ENV,
    env.NODE_ENV,
    env.BROWSERSLIST_DANGEROUS_EXTEND,
  ]);
}

function createScope(shared: ResolverOptions, baseDir: string): Scope {
  const allowFiles = shared.allow === undefined ? [ALLOW_FILE] : [];
  const { BROWSERSLIST, BROWSERSLIST_CONFIG } = process.env;
  return {
    options: shared,
    baseDir,
    // The variables of browserslist replace the lookup of its config.
    names: [
      ...(shared.targets === undefined && !BROWSERSLIST && !BROWSERSLIST_CONFIG ? TARGETS_FILES : []),
      ...allowFiles,
    ],
    bases: (shared.extends ?? []).map(target => resolveExtends(target, baseDir, '"extends" option')),
    inline:
      shared.allow === undefined
        ? undefined
        : { id: nextId(), entries: inlineEntries(shared.allow, baseDir, shared.where) },
    directories: new Map(),
    lookups: new Map(),
  };
}

// The project root computes its own configuration, so that its lookup names the places of a new config in the root.
function resolveDirectory(scope: Scope, directory: string): Configuration {
  const known = scope.directories.get(directory);
  if (known) {
    return known;
  }
  const parent = dirname(directory);
  const configuration =
    parent !== directory && directory !== scope.baseDir && !scope.names.some(name => existsSync(join(directory, name)))
      ? resolveDirectory(scope, parent)
      : compute(scope, directory);
  if (scope.directories.size >= DIRECTORY_LIMIT) {
    scope.directories.clear();
  }
  scope.directories.set(directory, configuration);
  return configuration;
}

// The errors of the binding that `compute` has given `watch` and `missing`: the error names no config itself.
const watchedErrors = new WeakSet<object>();

function compute(scope: Scope, directory: string): Configuration {
  counters.computations += 1;
  // The files of `watch` with their states.
  const states = new Map<string, string>();
  const where = scope.options.where ?? 'options';
  let { targets } = scope.options;
  let browsers: string[];
  // The places of a new config lie in the project root: the browserslist names first, then compatgate.jsonc.
  let missing: string[] = [];
  if (targets === undefined) {
    const found = resolveTargetsIn(directory, scope.options.defaultTargets, where, scope.baseDir);
    targets = found.query;
    browsers = found.browsers;
    for (const [path, state] of found.watch) {
      states.set(path, state);
    }
    missing = found.missing;
  } else {
    // A shared config of `extends` in the option resolves from the directory, as in a config.
    browsers = resolveBrowsers(targets, directory, `${where}.targets`);
  }
  const bases = scope.bases.map(readAllowFile);
  let project: AllowFile | undefined;
  let allowFile: string | null = null;
  if (scope.inline === undefined) {
    const found = findAllowFile(directory, scope.baseDir);
    missing = [...missing, ...found.missing];
    allowFile = found.path;
    project = found.path === null ? undefined : readAllowFile(found.path);
  }
  for (const file of project ? [...bases, project] : bases) {
    for (const [path, state] of file.files) {
      states.set(path, state);
    }
  }
  track(states, missing);
  const entries = combine(bases, project, scope.inline);
  let compiled: Compiled;
  try {
    compiled = compile(entries, browsers);
  } catch (error) {
    // Targets without data or an invalid glob fail in the binding, which does not name the config: a fix of any of
    // the configs may start a new check.
    if (error instanceof ConfigError) {
      error.watch = [...states.keys()];
      error.missing = missing;
      watchedErrors.add(error);
    }
    throw error;
  }
  // The advice of a finding names the place of a new entry: the option, the compatgate.jsonc of the project or, with
  // neither, the name of the config.
  const advice: DescribeFindingOptions =
    scope.inline !== undefined
      ? { allowIn: `${where}.allow` }
      : allowFile === null
        ? {}
        : { allowIn: allowFile, baseDir: scope.baseDir };
  return Object.freeze({
    targets,
    entries,
    checker: messagingChecker(compiled.checker, advice),
    issues: Object.freeze(
      compiled.issues.map(issue =>
        Object.freeze({
          ...issue,
          message: describeAllowIssue(issue, entries[issue.index] as AllowEntry, { baseDir: scope.baseDir }),
        }),
      ),
    ),
    ignoredBrowsers: compiled.ignoredBrowsers,
    watch: Object.freeze([...states.keys()]),
    missing: Object.freeze(missing),
  });
}

// The checkers that add the messages, by the checker of the binding, then by the place of a new entry. The directories
// of one checker of the binding name one place, as the place comes with the list of entries: they share one checker,
// and an adapter tells their configurations apart by it.
let messaging = new WeakMap<CoreChecker, Map<string, Checker>>();

function messagingChecker(core: CoreChecker, advice: DescribeFindingOptions): Checker {
  let byPlace = messaging.get(core);
  if (!byPlace) {
    byPlace = new Map();
    messaging.set(core, byPlace);
  }
  const key = JSON.stringify([advice.allowIn, advice.baseDir]);
  let checker = byPlace.get(key);
  if (!checker) {
    checker = Object.freeze({
      check(source: string, filename: string, parseAs?: string | null): CheckResult {
        const result = core.check(source, filename, parseAs);
        for (const finding of result.findings) {
          (finding as Finding).message = describeFinding(finding, advice);
        }
        return result as CheckResult;
      },
    });
    byPlace.set(key, checker);
  }
  return checker;
}

function combine(
  bases: readonly AllowFile[],
  project: AllowFile | undefined,
  inline: Scope['inline'],
): readonly AllowEntry[] {
  const own = project ?? inline;
  if (bases.length === 0) {
    return own?.entries ?? EMPTY;
  }
  if (bases.length === 1 && own === undefined) {
    return (bases[0] as AllowFile).inherited;
  }
  const key = `${bases.map(base => base.id).join(',')}|${own?.id ?? ''}`;
  return lists.get(key, () => Object.freeze([...bases.flatMap(base => base.inherited), ...(own?.entries ?? [])]));
}

const EMPTY: readonly AllowEntry[] = Object.freeze([]);

function compile(entries: readonly AllowEntry[], browsers: string[]): Compiled {
  let byTargets = checkers.get(entries);
  if (!byTargets) {
    byTargets = new LruCache(TARGETS_PER_LIST);
    checkers.set(entries, byTargets);
  }
  return byTargets.get(browsers.join(','), () => {
    const checker = createCoreChecker(browsers, entries);
    return {
      checker,
      issues: Object.freeze(checker.issues().map(issue => Object.freeze(issue))),
      ignoredBrowsers: Object.freeze(checker.ignoredBrowsers),
    };
  });
}

/**
 * A checker of the binding. An error of the binding becomes a `TargetsConfigError` or an `AllowConfigError` by its
 * code, with the error of the binding as the cause.
 */
export function createCoreChecker(browsers: string[], entries: readonly AllowEntry[]): CoreChecker {
  try {
    return new binding.Checker(browsers, entries.map(toCore));
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    const { code } = error as { code?: unknown };
    if (code === 'COMPATGATE_TARGETS') {
      throw new TargetsConfigError(error.message, { cause: error });
    }
    if (code === 'COMPATGATE_ALLOW') {
      throw new AllowConfigError(error.message, { cause: error });
    }
    throw error;
  }
}

/** An entry in the form that the binding takes. */
export interface CoreEntry {
  feature: string;
  packages: string[];
  files: string[];
  baseDir: string;
}

// The origin and the source serve the messages of the adapters only.
export function toCore(entry: AllowEntry): CoreEntry {
  return { feature: entry.feature, packages: [...entry.packages], files: [...entry.files], baseDir: entry.baseDir };
}

/** Sets `watch` and `missing` of a config error: the configs whose fix may start a new check. */
function watchFailure(error: unknown, options: ResolverOptions, directory: string): void {
  // As in a configuration, only the project root is watched for a new config.
  const root = resolve(options.baseDir ?? process.cwd());
  let places: string[];
  if (error instanceof AllowConfigError) {
    // An error of an inline entry or of the `extends` option has no file; the project config may still hold it.
    const path = error.path ?? (options.allow === undefined ? findAllowFile(directory).path : null);
    places = path === null ? [] : [path];
  } else if (error instanceof TargetsConfigError) {
    // The `targets` option replaces the lookup. An error that names no directory may come from any config between
    // the directory and the project root, or above a directory outside the root.
    const directories =
      options.targets !== undefined
        ? []
        : error.directory === undefined
          ? ancestors(directory, root)
          : [error.directory];
    places = directories.flatMap(place => TARGETS_FILES.map(name => join(place, name)));
  } else {
    return;
  }
  const states = places.map(path => [path, fileState(path)] as const);
  const watch = states.filter(([, state]) => state !== '');
  error.watch = watch.map(([path]) => path);
  error.missing = states.filter(([path, state]) => state === '' && dirname(path) === root).map(([path]) => path);
  track(watch, error.missing);
}

// The directory and its parents, up to `root` when the directory lies inside it.
function ancestors(directory: string, root: string): string[] {
  const list = [directory];
  for (let parent = dirname(directory); parent !== list.at(-1) && list.at(-1) !== root; parent = dirname(parent)) {
    list.push(parent);
  }
  return list;
}
