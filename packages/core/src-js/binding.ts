// The napi-rs loader picks the native binary or the WASI build for the current platform.
import { createRequire } from 'node:module';

import type * as Binding from '../binding.js';
// binding.js also exports the value objects `FindingKind`, `FindingConfidence`, `AllowIssueKind` and
// `ParseErrorKind`: napi registers string enums at run time. They are not part of the public API, and
// binding.d.ts declares them as string unions only.

/**
 * Loads the binding with `require`, so that a failure gets a message of its own: the loader of napi-rs advises a
 * reinstall of the dependencies, which does not help on a platform without a native package.
 */
function load(): typeof Binding {
  try {
    return createRequire(import.meta.url)('../binding.js') as typeof Binding;
  } catch (error) {
    throw new Error(
      `@compatgate/core cannot load its binary on ${process.platform}-${process.arch}: no package of it is installed ` +
        'for this platform, or the binary failed to load (see the cause). On a platform without a native package, ' +
        'install the WebAssembly build @compatgate/core-wasm32-wasi: see Requirements in the README of @compatgate/core.',
      { cause: error },
    );
  }
}

export const binding = load();
