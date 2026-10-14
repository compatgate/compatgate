import { OptionsError, type AllowEntryInput } from '@compatgate/core';

/** `settings.compatgate` of an ESLint or oxlint config. The three rules share it and take no options. */
export interface CompatgateSettings {
  /** browserslist query. Default: the browserslist config of the file. */
  targets?: string;
  /** Query to use when the project has no browserslist config. */
  defaultTargets?: string;
  /** Allow entries. Default: compatgate.jsonc above the file. */
  allow?: ReadonlyArray<string | AllowEntryInput>;
  /**
   * Base configs, as in `extends` of compatgate.jsonc. Their entries come before the entries of the project. A shared
   * lint config passes here the base list that the build passes to the bundler.
   */
  extends?: readonly string[];
  /** Report syntax too. Default: `false`, the transpiler of the build lowers syntax. */
  syntax?: boolean;
}

/** The name of the settings in messages: `settings.compatgate.allow[0]`. */
export const WHERE = 'settings.compatgate';

const KNOWN_KEYS: readonly (keyof CompatgateSettings)[] = ['targets', 'defaultTargets', 'allow', 'extends', 'syntax'];

/**
 * Checks `settings.compatgate`: the unknown keys and `syntax`. `createResolver` of the core checks the keys that
 * select the targets and the entries. Throws `OptionsError` of the core.
 */
export function readSettings(value: unknown): CompatgateSettings {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OptionsError(`${WHERE}: expected an object`);
  }
  const settings = value as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(settings)) {
    if (!(KNOWN_KEYS as readonly string[]).includes(key)) {
      throw new OptionsError(`${WHERE}: unknown key "${key}". Known keys: ${KNOWN_KEYS.join(', ')}`);
    }
  }
  // An absent value is the default: a shared config may unset a key this way.
  const { syntax } = settings;
  if (syntax !== undefined && typeof syntax !== 'boolean') {
    throw new OptionsError(`${WHERE}.syntax: expected a boolean`);
  }
  return settings as CompatgateSettings;
}
