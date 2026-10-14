import { binding } from './binding.ts';

export { AllowConfigError } from './allow.ts';
export type { AllowEntry, AllowEntryInput, AllowOrigin, AllowSource } from './allow.ts';
export { clearCaches, createResolver } from './configuration.ts';
export type { CheckOptions, Configuration, ResolveOptions, Resolver, ResolverOptions } from './configuration.ts';
export { ConfigError } from './errors.ts';
export { OptionsError } from './options.ts';
export type { SharedOptions } from './options.ts';
export { TargetsConfigError } from './targets.ts';
export type {
  AllowIssue,
  AllowIssueKind,
  CheckResult,
  Checker,
  ErrorCode,
  Finding,
  FindingConfidence,
  FindingKind,
  Gap,
  ParseError,
  ParseErrorKind,
  Position,
  Suppression,
} from './types.ts';

/**
 * Whether a checker can parse a file with this name: JavaScript or TypeScript by the extension.
 * A bundler id with a query (`/src/a.ts?v=123`) is no file name: strip the query before the call.
 */
export function isCheckable(filename: string): boolean {
  return binding.isCheckable(filename);
}

export function bcdVersion(): string {
  return binding.bcdVersion();
}
