import type { Host } from './host.ts';
import { pluginContextHost } from './plugin-context.ts';

/** Rollup: it has no lowering, and it sees a watched missing file appear, a new compatgate.jsonc too. */
export function rollupHost(): Host {
  return pluginContextHost({ watchMissing: true });
}
