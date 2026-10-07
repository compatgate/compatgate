import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import browserslist from 'browserslist';

export interface ResolveTargetsOptions {
  /** Query to use when the project has no browserslist config. */
  defaultTargets?: string;
}

export class TargetsConfigError extends Error {
  override name = 'TargetsConfigError';
}

/**
 * Finds the browserslist config that applies to `filename` and returns its query.
 * The Rust core resolves the query, but it cannot resolve `extends`: a shared config is a
 * JavaScript module, and it must be found from the checked file, not from the process directory.
 * So this function expands every `extends` term before it returns the query.
 */
export function resolveTargets(filename: string, options: ResolveTargetsOptions = {}): string {
  if (process.env.BROWSERSLIST) {
    return process.env.BROWSERSLIST;
  }
  const config = browserslist.loadConfig({ path: filename });
  if (config && config.length > 0) {
    return expandExtends(config, resolve(filename), []).join(', ');
  }
  return options.defaultTargets ?? 'defaults';
}

function expandExtends(queries: readonly string[], from: string, chain: readonly string[]): string[] {
  return queries
    .flatMap(query => query.split(','))
    .map(term => term.trim())
    .filter(term => term.length > 0)
    .flatMap(term => {
      const match = /^extends\s+(\S+)$/i.exec(term);
      if (!match) {
        return [term];
      }
      const name = match[1] as string;
      if (chain.includes(name)) {
        throw new TargetsConfigError(`${from}: circular browserslist "extends": ${[...chain, name].join(' -> ')}`);
      }
      const require = createRequire(from);
      let path: string;
      try {
        path = require.resolve(name);
      } catch {
        throw new TargetsConfigError(`${from}: cannot resolve the browserslist config "${name}" in "extends"`);
      }
      return expandExtends(pickEnvironment(require(path), name), path, [...chain, name]);
    });
}

// A shared config is either a list of queries or an object with one list per environment.
// browserslist uses the same environment variables and falls back to `defaults`.
function pickEnvironment(config: unknown, name: string): string[] {
  const environment = process.env.BROWSERSLIST_ENV ?? process.env.NODE_ENV ?? 'production';
  const queries =
    typeof config === 'object' && config !== null && !Array.isArray(config)
      ? ((config as Record<string, unknown>)[environment] ?? (config as Record<string, unknown>).defaults)
      : config;
  const list = typeof queries === 'string' ? [queries] : queries;
  if (!Array.isArray(list) || !list.every(item => typeof item === 'string')) {
    throw new TargetsConfigError(`The browserslist config "${name}" must export queries as strings`);
  }
  return list;
}
