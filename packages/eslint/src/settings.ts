import { SHARED_SCHEMA, checkOptions, type AllowEntryInput, type OptionSchema } from '@compatgate/core';

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

// The rules of the settings: the shared options of the core and `syntax`.
const SCHEMA: OptionSchema = {
  ...SHARED_SCHEMA,
  syntax: [value => typeof value === 'boolean', 'a boolean'],
};

/** Checks `settings.compatgate` against the rules of the core and of the plugin. Throws `OptionsError` of the core. */
export function readSettings(value: unknown): CompatgateSettings {
  if (value === undefined) {
    return {};
  }
  checkOptions(value, SCHEMA, WHERE);
  return value as CompatgateSettings;
}
