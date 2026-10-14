import { esbuildHost } from './esbuild.ts';
import type { Host } from './host.ts';
import { pluginContextHost } from './plugin-context.ts';
import { rolldownHost } from './rolldown.ts';
import { rollupHost } from './rollup.ts';
import { rspackHost } from './rspack.ts';
import { viteHost } from './vite.ts';
import { webpackHost } from './webpack.ts';

export type { BuildEnd, BuildEndContext, GraphModule, Host, HostReports, HookContext } from './host.ts';

/** The host table: one host per bundler of unplugin. Rsbuild runs the plugin of rspack. */
const HOSTS: Readonly<Record<string, () => Host>> = {
  webpack: webpackHost,
  rspack: rspackHost,
  rsbuild: rspackHost,
  vite: viteHost,
  rollup: rollupHost,
  rolldown: rolldownHost,
  esbuild: esbuildHost,
};

/**
 * The host of a bundler, new for each plugin instance. Another bundler of unplugin, such as Farm or Bun, gets the
 * context of Rollup without a lowering.
 */
export function createHost(framework: string): Host {
  return (HOSTS[framework] ?? (() => pluginContextHost({ watchMissing: false })))();
}
