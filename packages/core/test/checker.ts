import { inlineEntries, type AllowEntryInput } from '../src-js/allow.ts';
import { createCoreChecker } from '../src-js/configuration.ts';
import { OptionsError } from '../src-js/options.ts';
import { resolveBrowsers } from '../src-js/targets.ts';
import type { CoreChecker } from '../src-js/types.ts';

export interface CheckerOptions {
  /** browserslist query. A shared config of `extends` resolves from the process directory, then from `baseDir`. */
  targets: string;
  /** Feature ids and entries in the form of compatgate.jsonc. `suppressed` of the results indexes this list. */
  allow?: ReadonlyArray<string | AllowEntryInput>;
  /** Directory that relative `files` patterns of `allow` resolve against. Default: the process directory. */
  baseDir?: string;
}

/**
 * The checker of the binding for one query and one list of entries, without the lookup of
 * the configs and without the messages. Throws a `ConfigError`: `TargetsConfigError`, `AllowConfigError` or
 * `OptionsError`.
 */
export function createChecker(options: CheckerOptions): CoreChecker {
  // browserslist takes no query as "find the config", and a list as well as a string: neither is the contract here.
  if (typeof options.targets !== 'string') {
    throw new OptionsError('targets: expected a string');
  }
  const baseDir = options.baseDir ?? process.cwd();
  const allow = inlineEntries(options.allow ?? [], baseDir, undefined);
  return createCoreChecker(resolveBrowsers(options.targets, baseDir, 'targets'), allow);
}
