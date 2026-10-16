import { isAbsolute, posix, resolve, sep } from 'node:path';

import {
  SHARED_SCHEMA,
  checkOptions,
  type AllowEntryInput,
  type FindingConfidence,
  type OptionRule,
  type OptionSchema,
  type SharedOptions,
} from '@compatgate/core';
import picomatch from 'picomatch';
import type { FilterPattern } from 'unplugin';

/** `off` drops the findings of the level. */
export type Level = 'error' | 'warn' | 'off';

export interface CompatgateBundlerOptions {
  /** browserslist query. Default: the browserslist config of each module. */
  targets?: string;
  /** Query to use when a module has no browserslist config. Default: `defaults`. */
  defaultTargets?: string;
  /** Inline entries. They replace the lookup of compatgate.jsonc. Relative `files` resolve against the project root. */
  allow?: Array<string | AllowEntryInput>;
  /** Base configs, as in `extends` of compatgate.jsonc: paths of `.jsonc` files or package names. */
  extends?: string[];
  /**
   * Modules to check, by the path without the query. A string is a glob relative to the project root, a regular
   * expression tests the path with `/` separators. Default: every JavaScript and TypeScript module.
   */
  include?: FilterPattern;
  /** Modules to skip, in the form of `include`. */
  exclude?: FilterPattern;
  /** The level of the findings of each confidence. Default: `exact` is `error`, the others are `warn`. */
  severity?: { exact?: Level; heuristic?: Level; partial?: Level };
}

/** The name of the options in messages: `compatgate.allow[0]`. */
export const WHERE = 'compatgate';
const CONFIDENCES = ['exact', 'heuristic', 'partial'] as const satisfies readonly FindingConfidence[];
const LEVELS: readonly string[] = ['error', 'warn', 'off'] satisfies Level[];

const DEFAULT_SEVERITY: Readonly<Record<FindingConfidence, Level>> = {
  exact: 'error',
  heuristic: 'warn',
  partial: 'warn',
};

const FILTER: OptionRule = [
  value => (Array.isArray(value) ? value : [value]).every(item => typeof item === 'string' || item instanceof RegExp),
  'a glob, a regular expression or an array of them',
];
const LEVEL: OptionRule = [value => typeof value === 'string' && LEVELS.includes(value), '"error", "warn" or "off"'];
const SEVERITY: OptionSchema = { exact: LEVEL, heuristic: LEVEL, partial: LEVEL };

// The rules of the options: the shared options of the core, the filters and the levels.
const SCHEMA: OptionSchema = {
  ...SHARED_SCHEMA,
  include: FILTER,
  exclude: FILTER,
  severity: [(value, where) => (checkOptions(value, SEVERITY, where), true), 'an object'],
};

// A typo in a level or in a filter would turn the checks off without a word, and a value of a wrong type would
// fail in each module, so the options are checked when the plugin is made. `createResolver` of the core checks the
// keys of each `allow` entry.
export function readOptions(options: CompatgateBundlerOptions): {
  shared: SharedOptions;
  severity: Record<FindingConfidence, Level>;
} {
  checkOptions(options, SCHEMA, WHERE);
  const { targets, defaultTargets, allow, extends: bases } = options;
  const shared: SharedOptions = { targets, defaultTargets, allow, extends: bases };
  const levels: Record<FindingConfidence, Level> = { ...DEFAULT_SEVERITY };
  for (const confidence of CONFIDENCES) {
    const level = options.severity?.[confidence];
    if (level !== undefined) {
      levels[confidence] = level;
    }
  }
  return { shared, severity: levels };
}

/** The test of `include` and `exclude` on the path of a module without the query. */
export function createFilter(options: CompatgateBundlerOptions, baseDir: string): (path: string) => boolean {
  const include = matchers(options.include, baseDir);
  const exclude = matchers(options.exclude, baseDir);
  return path => {
    const posix = toPosix(path);
    if (exclude.some(test => test(posix))) {
      return false;
    }
    return include.length === 0 || include.some(test => test(posix));
  };
}

// The rules of `createFilter` of @rollup/pluginutils, on the path without the query. The project root is
// escaped: a directory such as `app (1)` must match itself, not act as a glob.
function matchers(pattern: FilterPattern | undefined, baseDir: string): Array<(path: string) => boolean> {
  const patterns = pattern === undefined ? [] : Array.isArray(pattern) ? pattern : [pattern];
  const base = toPosix(resolve(baseDir)).replace(/[-^$*+?.()|[\]{}!@#]/g, '\\$&');
  return patterns.map(item => {
    if (item instanceof RegExp) {
      return path => {
        item.lastIndex = 0;
        return item.test(path);
      };
    }
    const glob = item.startsWith('**') || isAbsolute(item) ? toPosix(item) : posix.join(base, toPosix(item));
    return picomatch(glob, { dot: true });
  });
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}
