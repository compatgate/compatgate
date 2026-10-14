import { viteLower, type ViteEnvironment } from '../lowering.ts';
import type { Host } from './host.ts';
import { dropFailedBuild, pluginContextHost } from './plugin-context.ts';

interface ViteConfig {
  root: string;
  command: 'build' | 'serve';
}

/**
 * Vite: the project root is `config.root`, and the build lowers the syntax for the target of the environment.
 * The build runs Rolldown, which does not see a watched missing file appear. In the dev server a watched missing
 * file would break the module: Vite takes a watched file of a transform for an import of the module. The dev
 * server has no end of a build (`endless`): a module reports its own errors and partial findings.
 */
export function viteHost(): Host {
  let serve = false;
  return {
    ...pluginContextHost({ watchMissing: false }),
    endless: () => serve,
    lower: context => viteLower((context as { environment?: ViteEnvironment }).environment),
    hooks: state => ({
      vite: {
        ...dropFailedBuild(state),
        // A server environment, such as SSR, runs the code in Node.js, not in the browsers of the targets.
        applyToEnvironment: (environment: { config: { consumer?: string } }) =>
          environment.config.consumer === 'client',
        configResolved(config: ViteConfig) {
          state.baseDir = config.root;
          serve = config.command === 'serve';
        },
        watchChange(id: string) {
          state.fileChanged(id);
        },
      },
    }),
  };
}
