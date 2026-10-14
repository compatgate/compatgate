import type { AllowEntryInput } from './allow.ts';
import { ConfigError } from './errors.ts';

/** The options that every adapter shares: they select the targets and the `allow` entries. */
export interface SharedOptions {
  /** browserslist query. Default: the browserslist config of the file. */
  targets?: string;
  /** Query to use when the project has no browserslist config. Default: `defaults`. */
  defaultTargets?: string;
  /** Allow entries. They replace the lookup of compatgate.jsonc. */
  allow?: ReadonlyArray<string | AllowEntryInput>;
  /**
   * Base configs, as in `extends` of compatgate.jsonc: paths of `.jsonc` files or package names. Their entries
   * come before the entries of the project.
   */
  extends?: readonly string[];
}

/** An option of a wrong type. A typo in an option would change the checks without a word. */
export class OptionsError extends ConfigError {
  override name = 'OptionsError';
  readonly code = 'COMPATGATE_OPTIONS';
}

const CHECKS: Record<keyof SharedOptions, [test: (value: unknown) => boolean, expected: string]> = {
  targets: [isString, 'a string'],
  defaultTargets: [isString, 'a string'],
  // The shape of each entry is checked when the entries are read, with the other errors of `allow`.
  allow: [Array.isArray, 'an array of feature ids and entries'],
  extends: [value => Array.isArray(value) && value.every(isString), 'an array of strings'],
};

/**
 * Checks the shared options of an adapter and gives them. `where` names the options in messages, such as
 * `settings.compatgate`. Other keys stay to the adapter: it knows its own options. An option set to `undefined`
 * takes its default, as an omitted one does. Throws `OptionsError`.
 */
export function readConfigurationOptions(options: Readonly<Record<string, unknown>>, where: string): SharedOptions {
  const shared: Record<string, unknown> = {};
  for (const [key, [test, expected]] of Object.entries(CHECKS)) {
    const value = options[key];
    if (value === undefined) {
      continue;
    }
    if (!test(value)) {
      throw new OptionsError(`${where}.${key}: expected ${expected}`);
    }
    shared[key] = value;
  }
  (shared.allow as unknown[] | undefined)?.forEach((entry, index) => {
    if (typeof entry !== 'string' && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
      throw new OptionsError(`${where}.allow[${index}]: expected a feature id or an object`);
    }
  });
  return shared as SharedOptions;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
