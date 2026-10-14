import type { Host } from './host.ts';
import { loaderHost } from './loader.ts';

/** webpack: the loader of unplugin runs the transform, and the project root is the `context` of the compiler. */
export function webpackHost(): Host {
  return loaderHost(meta => (meta.framework === 'webpack' ? meta.webpack.compiler.context : process.cwd()));
}
