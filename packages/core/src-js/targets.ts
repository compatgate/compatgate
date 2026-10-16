import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import browserslist from 'browserslist';

import { ConfigError } from './errors.ts';
import { fileState } from './file-state.ts';
import { isInside, samePath } from './paths.ts';

export class TargetsConfigError extends ConfigError {
  override name = 'TargetsConfigError';
  readonly code = 'COMPATGATE_TARGETS';
  /** The directory of the failing config, when the error names it. */
  directory: string | undefined;

  constructor(message: string, options?: ErrorOptions & { directory?: string }) {
    super(message, options);
    this.directory = options?.directory;
  }
}

/** The targets of a lookup directory: see `configLookupDirectory`. */
export interface ResolvedTargets {
  /** The query for messages: the queries of the config as written, `BROWSERSLIST` or the default query. */
  query: string;
  /** The browsers of the query as browserslist gives them, such as `chrome 120`. The binding takes them. */
  browsers: string[];
  /** The browserslist config or package.json. `null` for the `BROWSERSLIST` variable or the default query. */
  path: string | null;
  /**
   * The files that give the targets, with their states before browserslist read them: the config, and the
   * package.json of the project root when the lookup reaches the root, as it may get the browserslist field.
   */
  watch: Map<string, string>;
  /**
   * The places of a new browserslist config in the project root, when the lookup reaches the root: a config there
   * would apply instead of the found one or conflict with it. A new config in another directory needs a restart.
   */
  missing: string[];
}

/** The files of a browserslist config in each directory, in the order of `missing`. */
export const TARGETS_FILES = ['.browserslistrc', 'browserslist', 'package.json'];

/**
 * Finds the browserslist config of a lookup directory and resolves its query with the browserslist package, as for
 * a file in the directory. A file of a dependency has the directory of the project: see `configLookupDirectory`.
 * `where` names the options in the message of an invalid `defaultTargets`. `root` is the project root, the only
 * directory of `missing`. browserslist keeps what it reads until `clearTargetsCache`: the caller clears it when a file
 * of `watch` or `missing` changes.
 */
export function resolveTargetsIn(
  directory: string,
  defaultTargets: string | undefined,
  where = 'options',
  root?: string,
): ResolvedTargets {
  const { BROWSERSLIST: variable, BROWSERSLIST_CONFIG: file } = process.env;
  // browserslist takes a directory as well as a file: it looks for the config in it and above it.
  const found = variable ? null : (file ?? browserslistCall(() => browserslist.findConfigFile(directory)) ?? null);
  const path = found === null ? null : resolve(found);
  // The variables replace the lookup: no place of a config applies.
  const { watch: paths, missing } =
    variable || file ? { watch: path === null ? [] : [path], missing: [] } : places(directory, path, root);
  // The states come before loadConfig reads the config: an edit between the two shows at the next check.
  const files = { watch: new Map(paths.map(watched => [watched, fileState(watched)])), missing };
  // The browserslist field of package.json can be one string instead of a list, and loadConfig returns it as it is.
  // The lookup of loadConfig is in the cache already.
  const config: string | readonly string[] | undefined = browserslistCall(() =>
    browserslist.loadConfig({ path: directory, env: environment() }),
  );
  const queries = typeof config === 'string' ? [config] : config;
  if (queries && queries.length > 0) {
    // Messages name the config.
    const name = variable ? 'BROWSERSLIST' : (path ?? join(directory, 'package.json'));
    const browsers = resolveBrowsers(queries, directory, name, path === null ? undefined : dirname(path));
    return { query: queries.join(', '), browsers, path, ...files };
  }
  if (defaultTargets === undefined) {
    const browsers = resolveBrowsers('defaults', directory, 'default query');
    return { query: 'defaults', browsers, path: null, ...files };
  }
  return {
    query: defaultTargets,
    browsers: resolveBrowsers(defaultTargets, directory, `${where}.defaultTargets`),
    path: null,
    ...files,
  };
}

// The config is watched. A new config in the project root applies instead of the found one or conflicts with it when
// the lookup passes the root: the places of the root are missing, and its package.json is watched, as it may get the
// browserslist field. A new config in another directory needs a restart: every module registers its places with the
// bundler, and the places of each directory on the way made a build of 16 731 modules about 0.06 s slower.
function places(
  directory: string,
  config: string | null,
  root: string | undefined,
): { watch: string[]; missing: string[] } {
  const watch = config === null ? [] : [config];
  const missing: string[] = [];
  if (root !== undefined && isInside(root, directory) && (config === null || isInside(dirname(config), root))) {
    for (const path of TARGETS_FILES.map(name => join(root, name))) {
      if (!existsSync(path)) {
        missing.push(path);
      } else if (config === null || !samePath(path, config)) {
        watch.push(path);
      }
    }
  }
  return { watch, missing };
}

/**
 * Resolves a query with the browserslist package, as for a file in `directory`: a shared config of `extends`
 * resolves from the process directory, then from `directory`. `where` names the query in messages, and
 * `configDirectory` is the directory of its config.
 */
export function resolveBrowsers(
  query: string | readonly string[],
  directory: string,
  where: string,
  configDirectory?: string,
): string[] {
  const text = typeof query === 'string' ? query : query.join(', ');
  let browsers: string[];
  try {
    browsers = browserslist(query, { path: directory, env: environment() });
  } catch (error) {
    const { name, code, message } = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
    // A shared config of `extends` that is not installed fails in `require.resolve`.
    if (name === 'BrowserslistError' || code === 'MODULE_NOT_FOUND') {
      // The message of a missing module goes on with the stack of `require`.
      const first = String(message).split('\n', 1)[0];
      throw new TargetsConfigError(`${where}: ${text}: ${first}`, { cause: error, directory: configDirectory });
    }
    // browserslist has no guard against shared configs that extend each other: it recurses until the stack ends.
    if (error instanceof RangeError && error.message.startsWith('Maximum call stack size exceeded')) {
      throw new TargetsConfigError(`${where}: ${text}: circular browserslist "extends"`, {
        cause: error,
        directory: configDirectory,
      });
    }
    throw error;
  }
  if (browsers.length === 0) {
    throw new TargetsConfigError(`${where}: ${text}: selects no browser`, { directory: configDirectory });
  }
  return browsers;
}

// The environment that browserslist picks itself. Passed explicitly, it becomes part of the key of the cache of
// browserslist: the sections of a shared config in `extends` differ by environment, and `clearCaches` keeps the
// resolved queries.
function environment(): string {
  return process.env.BROWSERSLIST_ENV || process.env.NODE_ENV || 'production';
}

/**
 * Drops the configs and the lookups that browserslist keeps. browserslist then checks the age of its data again and
 * may warn of old data once more.
 */
export function clearTargetsCache(): void {
  browserslist.clearCaches();
}

// A conflict of configs, such as .browserslistrc next to the browserslist field of package.json, or a config
// that does not parse, throws a BrowserslistError: it becomes a targets error with the code.
function browserslistCall<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if ((error as Error | null)?.name === 'BrowserslistError') {
      const message = (error as Error).message;
      // The message of a conflict starts with the directory: `<dir> contains both .browserslistrc and ...`.
      const directory = /^(.+) contains both /.exec(message)?.[1];
      throw new TargetsConfigError(message, { cause: error, directory });
    }
    throw error;
  }
}
