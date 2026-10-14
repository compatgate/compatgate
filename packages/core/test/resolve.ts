// The calls of an adapter in one function, for tests that check one file at a time.

import { createResolver, type ResolveOptions, type ResolverOptions } from '../src-js/configuration.ts';
import type { CheckResult } from '../src-js/types.ts';

export type ConfigurationOptions = ResolverOptions & ResolveOptions;

/** A new resolver of `options`, then the configuration of `filename`. */
export function resolveConfiguration(filename: string, { snapshot, ...options }: ConfigurationOptions = {}) {
  return createResolver(options).resolve(filename, { snapshot });
}

/** Checks one file with the checker of its configuration. */
export function check(
  source: string,
  { filename, parseAs, snapshot, ...options }: ConfigurationOptions & { filename: string; parseAs?: string },
): CheckResult {
  return createResolver(options).check(source, filename, { parseAs, snapshot });
}
