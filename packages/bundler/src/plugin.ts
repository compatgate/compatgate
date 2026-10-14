import type { UnpluginContextMeta, UnpluginOptions } from 'unplugin';

import { createHost, type BuildEndContext } from './hosts/index.ts';
import { TRANSFORM_FILTER } from './module-id.ts';
import type { CompatgateBundlerOptions } from './options.ts';
import { endBuild, transformModule } from './pipeline.ts';
import { PluginState } from './state.ts';

export type { FilterPattern } from 'unplugin';
export { checkModule, type CheckModuleOptions, type PartialMode } from './check.ts';
export type { Lower, LoweredCode } from './lowering.ts';
export type { CompatgateBundlerOptions, Level } from './options.ts';
export { sourceMapLocate, type Locate, type SourcePosition } from './source-map.ts';
export { PluginState, clearProcessMessages, type ModuleContext, type Scope } from './state.ts';
export type { ModuleRecord } from './records.ts';
export type { PartialFinding } from './summary.ts';

/** The plugin of unplugin: the shared pipeline in the hooks, with the host of the bundler that runs it. */
export function createPlugin(
  options: CompatgateBundlerOptions | null | undefined,
  meta: UnpluginContextMeta,
): UnpluginOptions {
  const host = createHost(meta.framework);
  const state = new PluginState(options ?? {}, host.root(meta), () => host.endless?.() ?? false);
  return {
    name: 'compatgate',
    enforce: 'post',
    buildStart(this: unknown, ...args: unknown[]) {
      state.startBuild();
      host.buildStart?.(state, args[0]);
    },
    transform: {
      filter: { id: TRANSFORM_FILTER },
      async handler(code, id) {
        await transformModule(state, host, this, code, id);
        return null;
      },
    },
    buildEnd(this: unknown, ...args: unknown[]) {
      endBuild(state, host, this as BuildEndContext | undefined, Boolean(args[0]));
    },
    ...host.hooks?.(state),
  };
}
