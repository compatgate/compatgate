import { createUnplugin, type UnpluginInstance } from 'unplugin';

import { createPlugin, type CompatgateBundlerOptions } from './plugin.ts';

export { OptionsError } from '@compatgate/core';
export type { CompatgateBundlerOptions, FilterPattern, Level } from './plugin.ts';

type Instance = UnpluginInstance<CompatgateBundlerOptions | undefined, false>;

/** The unplugin factory. Each bundler takes its own plugin: `compatgate.webpack(options)` and so on. */
export const compatgate: Instance = createUnplugin<CompatgateBundlerOptions | undefined, false>(createPlugin);

// The types name the members of the instance: the plugin types of a bundler come from its own package, and
// without the annotations the declarations would name them directly.
export const compatgateWebpack: Instance['webpack'] = compatgate.webpack;
export const compatgateRspack: Instance['rspack'] = compatgate.rspack;
export const compatgateVite: Instance['vite'] = compatgate.vite;
export const compatgateRollup: Instance['rollup'] = compatgate.rollup;
export const compatgateRolldown: Instance['rolldown'] = compatgate.rolldown;
export const compatgateEsbuild: Instance['esbuild'] = compatgate.esbuild;
