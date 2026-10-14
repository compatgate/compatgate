import { extname } from 'node:path';

import { esbuildLower, type EsbuildOptions, type TsconfigCache } from '../lowering.ts';
import { ESBUILD_FILTER, SCRIPT_LOADERS, moduleFile } from '../module-id.ts';
import type { Host, HookContext } from './host.ts';
import { pluginChannels } from './plugin-context.ts';

/** The esbuild of the build that runs the plugin: the transform context of unplugin gives its `build`. */
function nativeEsbuild(context: HookContext) {
  const native = context.getNativeBuildContext?.();
  return native?.framework === 'esbuild'
    ? (native.build as { esbuild?: Parameters<typeof esbuildLower>[1] }).esbuild
    : undefined;
}

/**
 * esbuild: the plugin loads the file and checks it as it is, so a position is in the source. esbuild lowers the
 * syntax after `onLoad`, and it sees a watched missing file appear. It gives a plugin no list of the modules of
 * a build: the build has no reports at its end.
 */
export function esbuildHost(): Host {
  // The `loader` option of the build overrides the loaders of the scripts, as esbuild does when it loads a file
  // itself: `{ '.js': 'jsx' }` is common.
  let loaders: Readonly<Record<string, string>> = SCRIPT_LOADERS;
  const loader = (path: string) => loaders[extname(path).toLowerCase()] ?? 'js';
  let options: EsbuildOptions | undefined;
  const tsconfigs: TsconfigCache = new Map();
  return {
    root: () => process.cwd(),
    file: (_context, id) => moduleFile(id),
    locate: (_context, file) => start => ({ path: file.path, ...start }),
    lower: context => esbuildLower(options, nativeEsbuild(context), loader, tsconfigs),
    channels: (context, errors) => pluginChannels(context, errors, true),
    buildStart() {
      tsconfigs.clear();
    },
    hooks: state => ({
      esbuild: {
        onLoadFilter: ESBUILD_FILTER,
        loader: (_code, id) => loader(id) as never,
        config(input) {
          state.baseDir = input.absWorkingDir ?? process.cwd();
          loaders = { ...SCRIPT_LOADERS, ...input.loader };
          options = input as EsbuildOptions;
        },
      },
    }),
  };
}
