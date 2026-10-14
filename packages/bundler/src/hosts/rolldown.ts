import { rolldownLower, type RolldownOptions } from '../lowering.ts';
import type { Host } from './host.ts';
import { dropFailedBuild, pluginContextHost } from './plugin-context.ts';

/**
 * Rolldown: it lowers the syntax after the transforms, its `cwd` option is the project root, and it does not
 * see a watched missing file appear.
 */
export function rolldownHost(): Host {
  let options: RolldownOptions | undefined;
  return {
    ...pluginContextHost({ watchMissing: false }),
    lower: () => rolldownLower(options),
    buildStart(state, input) {
      const cwd = (input as { cwd?: unknown } | undefined)?.cwd;
      if (typeof cwd === 'string') {
        state.baseDir = cwd;
      }
    },
    hooks: state => ({
      rolldown: {
        ...dropFailedBuild(state),
        options(input) {
          options = input as RolldownOptions;
        },
      },
    }),
  };
}
