import { moduleFile } from '../module-id.ts';
import { sourceMapLocate, type Locate } from '../source-map.ts';
import type { ModuleContext, PluginState } from '../state.ts';
import type { BuildEndContext, GraphModule, Host, HookContext } from './host.ts';

// Rollup, Rolldown and Vite give the plugin the context of Rollup: `this.warn`, `this.addWatchFile`, the combined
// source map and the list of the modules of the build. Their hosts are this one with their own properties.

/**
 * The channels of a module through the context of the plugin. The errors go to `errors`: the plugin reports them
 * at the end of the build, or at the end of the module in the dev server of Vite. `watchMissing` tells whether
 * the bundler sees a watched file appear.
 */
export function pluginChannels(context: HookContext, errors: string[], watchMissing: boolean): ModuleContext {
  return {
    error: message => errors.push(message),
    warn: message => context.warn(message),
    addWatchFile: path => context.addWatchFile(path),
    addMissingFile: path => {
      if (watchMissing) {
        context.addWatchFile(path);
      }
    },
  };
}

/**
 * The hook that drops the records of a failed build when the bundle closes. Rollup calls the `buildEnd` hooks in
 * parallel, so the end of the build of compatgate does not see an error of another plugin there; `closeBundle`
 * gets it. Rollup keeps the cache of the build before a failed one, and a record of the failed build would pass
 * for a record of the code in that cache.
 */
export function dropFailedBuild(state: PluginState): { closeBundle(error?: unknown): void } {
  return {
    closeBundle(error) {
      if (error) {
        state.records.dropBuild();
      }
    },
  };
}

/** The code after the plugins before compatgate, and the combined source map of those plugins. */
function combinedSourceMap(context: HookContext, file: Parameters<Host['locate']>[1]): Locate | undefined {
  const combined = (context as { getCombinedSourcemap?: () => unknown }).getCombinedSourcemap;
  return typeof combined === 'function' ? sourceMapLocate(file, () => combined.call(context)) : undefined;
}

/**
 * A host with the context of Rollup. `watchMissing`: the bundler sees a watched missing file appear. The project
 * root is the process directory unless the host reads its own.
 */
export function pluginContextHost({ watchMissing }: { watchMissing: boolean }): Host {
  return {
    root: () => process.cwd(),
    file: (_context, id) => moduleFile(id),
    locate: combinedSourceMap,
    lower: () => undefined,
    channels: (context, errors) => pluginChannels(context, errors, watchMissing),
    hooks: state => ({ rollup: dropFailedBuild(state) }),
    reports: {
      // A warning shows at once and cannot be taken back: a partial one waits for the summary.
      partial: () => 'hold',
      end(context, failed) {
        // Rollup, Rolldown and the build of Vite give `this.warn` at the end of a build, and the held partial
        // findings need it.
        const { warn } = context;
        if (typeof warn !== 'function') {
          return null;
        }
        return {
          partial: 'hold',
          modules: () => {
            // A failed build has not checked every module.
            const ids = failed ? undefined : context.getModuleIds?.();
            return ids === undefined ? null : bundleModules(context, ids);
          },
          warn: messages => {
            for (const message of messages) {
              warn.call(context, message);
            }
          },
        };
      },
    },
  };
}

/** The modules of the build without the external ones: no transform sees an external module. */
function* bundleModules(context: BuildEndContext, ids: Iterable<string>): Generator<GraphModule> {
  for (const id of ids) {
    if (!isExternal(context.getModuleInfo?.(id))) {
      yield { id, file: () => moduleFile(id) };
    }
  }
}

/** Rolldown gives no `isExternal`, and an external module has no code there. */
function isExternal(info: { isExternal?: boolean; code?: string | null } | null | undefined): boolean {
  return info?.isExternal ?? info?.code === null;
}
