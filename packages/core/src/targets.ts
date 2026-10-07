import browserslist from 'browserslist';

export interface ResolveTargetsOptions {
  /** Query to use when the project has no browserslist config. */
  defaultTargets?: string;
}

/**
 * Finds the browserslist config that applies to `filename` and returns its query.
 * The Rust core resolves the query. Only JavaScript can find the config, because
 * `extends` in a browserslist config loads a shared config as a JavaScript module.
 */
export function resolveTargets(filename: string, options: ResolveTargetsOptions = {}): string {
  if (process.env.BROWSERSLIST) {
    return process.env.BROWSERSLIST;
  }
  const config = browserslist.loadConfig({ path: filename });
  if (config && config.length > 0) {
    return config.join(', ');
  }
  return options.defaultTargets ?? 'defaults';
}
