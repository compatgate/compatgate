import { loadAllow, loadAllowFile, type AllowEntry } from './allow.ts';
import { binding } from './binding.ts';
import { resolveTargets } from './targets.ts';

export { ALLOW_FILE, AllowConfigError, clearAllowCache, findAllowFile, loadAllow, loadAllowFile } from './allow.ts';
export type { AllowConfig, AllowEntry } from './allow.ts';
export { resolveTargets } from './targets.ts';
export type { ResolveTargetsOptions } from './targets.ts';

export interface CheckOptions {
  /** Path of the checked file. Selects the parser and finds the configs. */
  filename: string;
  /** browserslist query. Default: the browserslist config of `filename`. */
  targets?: string;
  /** Query to use when the project has no browserslist config. */
  defaultTargets?: string;
  /** Allow entries. Default: compatgate.jsonc above `filename`. */
  allow?: AllowEntry[];
  /** Path of the allow config, used when `allow` is not given. */
  allowFile?: string;
}

export type CheckResult = ReturnType<typeof binding.check>;

export function check(source: string, options: CheckOptions): CheckResult {
  const targets = options.targets ?? resolveTargets(options.filename, { defaultTargets: options.defaultTargets });
  const allow =
    options.allow ?? (options.allowFile ? loadAllowFile(options.allowFile) : loadAllow(options.filename)).entries;
  return binding.check(source, { filename: options.filename, targets, allow });
}

export function validateAllow(allow: AllowEntry[], targets: string): ReturnType<typeof binding.validateAllow> {
  return binding.validateAllow(allow, targets);
}

export function bcdVersion(): string {
  return binding.bcdVersion();
}
