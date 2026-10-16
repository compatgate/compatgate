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

/**
 * The rule of one option: a test of its value and what a message says the value should be. `where` names the
 * option, such as `settings.compatgate.allow`: a test may throw its own error for a part of the value.
 */
export type OptionRule = readonly [test: (value: unknown, where: string) => boolean, expected: string];

/** The keys of an object of options and their rules. */
export type OptionSchema = Readonly<Record<string, OptionRule>>;

export interface CheckOptionsSettings {
  /** The class of the errors. Default: `OptionsError`. */
  error?: new (message: string) => Error;
  /** The name of a key in messages. Default: `<where>.<key>`. */
  label?: (key: string) => string;
  /** Advice after the message about an unknown key, such as `. Write the reason as a comment`. */
  hint?: (key: string) => string;
}

/**
 * Checks an object of options against `schema`: each key is known and each value passes its rule. A key set to
 * `undefined` takes its default, as an omitted one does. One check for the options of every adapter, the settings
 * of ESLint, compatgate.jsonc and its entries, so a typo fails the same way everywhere instead of changing the checks
 * without a word.
 */
export function checkOptions(
  value: unknown,
  schema: OptionSchema,
  where: string,
  { error: Failure = OptionsError, label = key => `${where}.${key}`, hint = () => '' }: CheckOptionsSettings = {},
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Failure(`${where}: expected an object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  // JSON gives an object a prototype of its own for a key `__proto__`, and `Object.keys` does not show it: the fields
  // of the prototype would apply unchecked.
  const prototype: unknown = Object.getPrototypeOf(value);
  const keys = prototype === Object.prototype || prototype === null ? [] : ['__proto__'];
  for (const key of [...keys, ...Object.keys(record)]) {
    const item = key === '__proto__' ? prototype : record[key];
    if (item === undefined) {
      continue;
    }
    const rule = Object.hasOwn(schema, key) ? schema[key] : undefined;
    if (rule === undefined) {
      throw new Failure(`${where}: unknown key "${key}". Known keys: ${Object.keys(schema).join(', ')}${hint(key)}`);
    }
    const [test, expected] = rule;
    if (!test(item, label(key))) {
      throw new Failure(`${label(key)}: expected ${expected}`);
    }
  }
}

/** The rules of the options that every adapter shares. An adapter adds its own: `{ ...SHARED_SCHEMA, syntax }`. */
export const SHARED_SCHEMA: { readonly [key in keyof SharedOptions]-?: OptionRule } = {
  targets: [isString, 'a string'],
  defaultTargets: [isString, 'a string'],
  // The keys of each entry are checked when the entries are read, with the other errors of `allow`.
  allow: [
    (value, where) => {
      if (!Array.isArray(value)) {
        return false;
      }
      value.forEach((entry: unknown, index) => {
        if (typeof entry !== 'string' && (typeof entry !== 'object' || entry === null || Array.isArray(entry))) {
          throw new OptionsError(`${where}[${index}]: expected a feature id or an object`);
        }
      });
      return true;
    },
    'an array of feature ids and entries',
  ],
  extends: [value => Array.isArray(value) && value.every(isString), 'an array of strings'],
};

/**
 * Checks the options of `createResolver` and gives the shared ones. `where` names the options in messages, such as
 * `settings.compatgate`. Throws `OptionsError`.
 */
export function readConfigurationOptions(options: unknown, where: string): SharedOptions {
  checkOptions(options, { ...SHARED_SCHEMA, baseDir: [isString, 'a string'], where: [isString, 'a string'] }, where);
  const { targets, defaultTargets, allow, extends: bases } = options as SharedOptions;
  const shared: SharedOptions = { targets, defaultTargets, allow, extends: bases };
  for (const key of Object.keys(shared) as (keyof SharedOptions)[]) {
    if (shared[key] === undefined) {
      delete shared[key];
    }
  }
  return shared;
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}
