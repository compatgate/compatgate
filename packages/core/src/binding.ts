import { createRequire } from 'node:module';

import type * as Binding from '../binding.cjs';

// napi-rs generates a CommonJS loader that picks the binary for the current platform.
export const binding: typeof Binding = createRequire(import.meta.url)('../binding.cjs');
