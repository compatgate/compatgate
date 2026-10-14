import type { AddressInfo } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
import { join } from 'node:path';

import vue from '@vitejs/plugin-vue';
import * as esbuild from 'esbuild';
import { rolldown } from 'rolldown';
import { rollup, watch as rollupWatch, type Plugin as RollupPlugin, type RollupWatcherEvent } from 'rollup';
import { build as viteBuild, createServer as createViteServer, type Logger, type PluginOption } from 'vite';

import { editFile } from './helpers.ts';
import {
  compatgateEsbuild,
  compatgateRolldown,
  compatgateRollup,
  compatgateVite,
  type CompatgateBundlerOptions,
} from '../src/index.ts';

/** The result of a build of Vite, Rollup, Rolldown or esbuild: the message of the failed build and the warnings. */
export interface HostResult {
  error: string | undefined;
  warnings: string[];
}

export interface HostBuildOptions {
  /** Plugins of the bundler that run before compatgate. */
  plugins?: unknown[];
  /** Adds `@vitejs/plugin-vue` (Vite only). */
  vue?: boolean;
  /** `build.sourcemap` of Vite. */
  sourcemap?: boolean;
  /**
   * The target that the bundler lowers the syntax for: `build.target` of Vite, `transform.target` of Rolldown,
   * `target` of esbuild. Rollup has none. Absent: the default of the bundler.
   */
  target?: string;
  /** Absolute paths of modules that stay out of the bundle (Vite, Rollup and Rolldown). */
  external?: string[];
}

export interface Host {
  name: 'vite' | 'rollup' | 'rolldown' | 'esbuild';
  build(root: string, options?: CompatgateBundlerOptions, build?: HostBuildOptions): Promise<HostResult>;
}

const entry = (root: string) => join(root, 'src/index.ts');

// ANSI colors of the loggers stay out of the assertions.
const plain = (text: string) => stripVTControlCharacters(text);

function message(error: unknown): string {
  return plain(error instanceof Error ? error.message : String(error));
}

/** A logger of Vite that keeps the warnings and drops the rest. */
function viteLogger(warnings: string[]): Logger {
  const keep = (text: string) => warnings.push(plain(text));
  return {
    hasWarned: false,
    info() {},
    warn: keep,
    warnOnce: keep,
    error() {},
    clearScreen() {},
    hasErrorLogged: () => false,
  };
}

export const viteHost: Host = {
  name: 'vite',
  async build(root, options, build = {}) {
    const warnings: string[] = [];
    try {
      await viteBuild({
        root,
        configFile: false,
        logLevel: 'warn',
        customLogger: viteLogger(warnings),
        plugins: [...(build.vue ? [vue()] : []), ...((build.plugins ?? []) as PluginOption[]), compatgateVite(options)],
        build: {
          write: false,
          sourcemap: build.sourcemap ?? false,
          ...(build.target === undefined ? {} : { target: build.target }),
          rolldownOptions: { input: entry(root), external: build.external },
        },
      });
      return { error: undefined, warnings };
    } catch (error) {
      return { error: message(error), warnings };
    }
  },
};

/** TypeScript for Rollup: esbuild removes the types and gives a source map, as a TypeScript plugin does. */
export const typescript: RollupPlugin = {
  name: 'test-typescript',
  async transform(code, id) {
    if (!id.endsWith('.ts')) {
      return null;
    }
    const result = await esbuild.transform(code, { loader: 'ts', sourcemap: true, sourcefile: id, format: 'esm' });
    return { code: result.code, map: result.map };
  },
};

export const rollupHost: Host = {
  name: 'rollup',
  async build(root, options, build = {}) {
    const warnings: string[] = [];
    try {
      const bundle = await rollup({
        input: entry(root),
        external: build.external,
        plugins: [typescript, ...((build.plugins ?? []) as RollupPlugin[]), compatgateRollup(options)],
        onwarn: warning => warnings.push(plain(warning.message)),
      });
      await bundle.close();
      return { error: undefined, warnings };
    } catch (error) {
      return { error: message(error), warnings };
    }
  },
};

export const rolldownHost: Host = {
  name: 'rolldown',
  async build(root, options, build = {}) {
    const warnings: string[] = [];
    try {
      const bundle = await rolldown({
        cwd: root,
        input: entry(root),
        external: build.external,
        ...(build.target === undefined ? {} : { transform: { target: build.target } }),
        plugins: [...((build.plugins ?? []) as never[]), compatgateRolldown(options)],
        onwarn: warning => warnings.push(plain(warning.message)),
      });
      // Rolldown builds the modules on `generate`.
      try {
        await bundle.generate();
      } finally {
        await bundle.close();
      }
      return { error: undefined, warnings };
    } catch (error) {
      return { error: message(error), warnings };
    }
  },
};

export const esbuildHost: Host = {
  name: 'esbuild',
  async build(root, options, build = {}) {
    try {
      const result = await esbuild.build({
        absWorkingDir: root,
        ...(build.target === undefined ? {} : { target: build.target }),
        entryPoints: [entry(root)],
        bundle: true,
        write: false,
        logLevel: 'silent',
        plugins: [compatgateEsbuild(options)],
      });
      return { error: undefined, warnings: result.warnings.map(warning => warning.text) };
    } catch (error) {
      const warnings = (error as { warnings?: esbuild.Message[] }).warnings ?? [];
      return { error: message(error), warnings: warnings.map(warning => warning.text) };
    }
  },
};

/** Rollup in watch mode: each `next` waits for the end of the next build. */
export interface RollupWatch {
  next(): Promise<HostResult>;
  /**
   * Writes a file and waits until the watcher sees it. Rollup gives the watcher the files of a build at its end,
   * and the watcher of the file system takes its time to start: an edit right after the end may go unseen, so
   * the edit repeats until the watcher reports it.
   */
  edit(path: string, content: string): Promise<void>;
  close(): Promise<void>;
}

/** Rollup in watch mode. `plugins` run after compatgate. */
export function watchRollup(
  root: string,
  options?: CompatgateBundlerOptions,
  plugins: RollupPlugin[] = [],
): RollupWatch {
  const results: HostResult[] = [];
  const waiting: Array<(result: HostResult) => void> = [];
  let current: HostResult = { error: undefined, warnings: [] };
  const watcher = rollupWatch({
    input: entry(root),
    plugins: [typescript, compatgateRollup(options), ...plugins],
    onwarn: warning => current.warnings.push(plain(warning.message)),
    watch: { skipWrite: true },
  });
  const finish = (result: HostResult) => {
    const resolve = waiting.shift();
    if (resolve) {
      resolve(result);
    } else {
      results.push(result);
    }
  };
  watcher.on('event', (event: RollupWatcherEvent) => {
    if (event.code === 'START') {
      current = { error: undefined, warnings: [] };
    } else if (event.code === 'ERROR') {
      current.error = message(event.error);
      void event.result?.close();
    } else if (event.code === 'BUNDLE_END') {
      void event.result.close();
    } else if (event.code === 'END') {
      finish(current);
    }
  });
  return {
    next: () => {
      const result = results.shift();
      if (result) {
        return Promise.resolve(result);
      }
      // A rebuild that never comes fails the test with a message instead of the timeout of the test runner.
      return new Promise((resolve, reject) => {
        const waiter = (value: HostResult) => {
          clearTimeout(timer);
          resolve(value);
        };
        // A late build goes to the next `next`, not to this rejected promise.
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          reject(new Error('rollup watch: no build in 10 s'));
        }, 10_000);
        waiting.push(waiter);
      });
    },
    async edit(path, content) {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const seen = new Promise<boolean>(resolve => {
          const timer = setTimeout(() => {
            watcher.off('change', listener);
            resolve(false);
          }, 200);
          const listener = (id: string) => {
            if (id === path) {
              clearTimeout(timer);
              watcher.off('change', listener);
              resolve(true);
            }
          };
          watcher.on('change', listener);
        });
        editFile(path, content);
        if (await seen) {
          return;
        }
      }
      throw new Error(`rollup watch: the watcher does not see ${path}`);
    },
    close: () => watcher.close(),
  };
}

/** A Vite dev server on a free port. `get` requests a module the way a browser does. */
export interface ViteDevServer {
  get(path: string): Promise<{ status: number; body: string }>;
  /** Runs a module in the SSR environment of the server. */
  ssrLoad(path: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function serveVite(
  root: string,
  options?: CompatgateBundlerOptions,
  build: HostBuildOptions = {},
): Promise<ViteDevServer> {
  const vite = await createViteServer({
    root,
    configFile: false,
    logLevel: 'silent',
    customLogger: viteLogger([]),
    plugins: [...(build.vue ? [vue()] : []), compatgateVite(options)],
    ...(build.target === undefined ? {} : { build: { target: build.target } }),
    // Port 0 takes a free port. The middleware mode would hide an error of a module behind a 404.
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await vite.listen();
  const { port } = vite.httpServer!.address() as AddressInfo;
  return {
    async get(path) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: response.status, body: await response.text() };
    },
    ssrLoad: path => vite.ssrLoadModule(path),
    close: () => vite.close(),
  };
}

/** Repeats `probe` until it gives a truthy value: a watcher of the file system takes its time. */
export async function eventually<T>(probe: () => Promise<T>, timeout = 10_000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value || Date.now() > end) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
