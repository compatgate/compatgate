import type { Host } from './host.ts';
import { loaderHost } from './loader.ts';

/**
 * rspack: the loader of unplugin runs the transform, and the project root is the `context` of the compiler.
 * Rsbuild runs rspack too, and its plugin gives no compiler: the root is the process directory there.
 */
export function rspackHost(): Host {
  return loaderHost(meta => (meta.framework === 'rspack' ? meta.rspack.compiler.context : process.cwd()));
}
