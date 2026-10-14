/**
 * An error of a config or of the options: the user fixes it in the config. `TargetsConfigError`,
 * `AllowConfigError` and `OptionsError` extend it.
 */
export abstract class ConfigError extends Error {
  abstract readonly code: 'COMPATGATE_TARGETS' | 'COMPATGATE_ALLOW' | 'COMPATGATE_OPTIONS';
  /** Set by `resolveConfiguration`: the configs to watch, so that a fix starts a new check. */
  watch: readonly string[] = [];
  /** Set by `resolveConfiguration`: the configs whose appearance may fix the error. */
  missing: readonly string[] = [];
}
