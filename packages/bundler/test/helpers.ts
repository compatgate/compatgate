import { readdirSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { editFile } from '@compatgate/test-utils';
import { rspack, type RspackOptions } from '@rspack/core';
import webpack, { type Configuration } from 'webpack';

import { compatgateRspack, compatgateWebpack, type CompatgateBundlerOptions } from '../src/index.ts';

export const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';

const require = createRequire(import.meta.url);

/**
 * Moves the modification time of the files of a project a minute back. webpack takes a file changed within the
 * accuracy of the file system clock for a changed one, and builds its module again.
 */
export function backdateFiles(root: string): void {
  const earlier = new Date(Date.now() - 60_000);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      utimesSync(join(entry.parentPath, entry.name), earlier, earlier);
    }
  }
}

export interface BuildResult {
  errors: string[];
  warnings: string[];
  /** The loaders of each module, by the path of its resource, where the bundler gives them. */
  loaders: Map<string, string[]>;
  /** The files and the missing files whose change starts a new build of a module. */
  fileDependencies: Set<string>;
  missingDependencies: Set<string>;
  /** The warnings of the child compilations: the build does not show them with its own. */
  childWarnings: string[];
}

export interface BuildOptions {
  entry?: string;
  /**
   * `true` keeps the modules in memory between the runs of one compiler. `filesystem` keeps them in the
   * `.cache` directory of the project, for the next compiler: the persistent cache of webpack and rspack.
   */
  cache?: boolean | 'filesystem';
  /**
   * `production` concatenates the modules. `development` makes rspack build again only the changed modules in
   * watch mode. Default: `none`.
   */
  mode?: 'none' | 'development' | 'production';
  /** `source-map` makes the loaders give source maps. Default: `false`. */
  devtool?: false | 'source-map';
  /** The entry of a child compilation, as html-webpack-plugin makes one. */
  child?: string;
  /** Rules of the loaders before the rules of the test. */
  rules?: unknown[];
}

/** A compiler that runs several builds, as watch mode does. */
export interface TestCompiler {
  run(): Promise<BuildResult>;
  close(): Promise<void>;
}

/** A compiler in watch mode: each edit of a watched file starts a build. */
export interface TestWatch {
  next(): Promise<BuildResult>;
  /** Writes a file and waits until the compiler sees the change. */
  edit(path: string, content: string): Promise<void>;
  close(): Promise<void>;
}

export interface Bundler {
  name: 'rspack' | 'webpack';
  compiler(root: string, options?: CompatgateBundlerOptions, build?: BuildOptions): TestCompiler;
  build(root: string, options?: CompatgateBundlerOptions, build?: BuildOptions): Promise<BuildResult>;
  watch(root: string, options?: CompatgateBundlerOptions, build?: BuildOptions): TestWatch;
}

// The files that a test transpiles: TypeScript and JavaScript of the project and of node_modules. A module of
// `flow-lib` and CSS stay as they are: `asset/source` makes their text a string export, so the bundler accepts
// the text that compatgate cannot parse.
function rules(loader: unknown, extra: unknown[] = []): NonNullable<Configuration['module']>['rules'] {
  return [
    ...(extra as never[]),
    { test: /\.css$/, type: 'asset/source' },
    { test: /[\\/]flow-lib[\\/]/, type: 'asset/source' },
    { test: /\.[cm]?[jt]s$/, exclude: /[\\/]flow-lib[\\/]/, use: loader as never },
  ];
}

const swcOptions = {
  jsc: { parser: { syntax: 'typescript' } },
  env: { targets: TARGETS },
};

function common(root: string, build: BuildOptions) {
  return {
    mode: build.mode ?? 'none',
    context: root,
    entry: build.entry ?? './src/index.ts',
    target: `browserslist:${TARGETS}` as const,
    devtool: build.devtool ?? false,
    output: { path: join(root, 'dist') },
    resolve: { extensions: ['.ts', '.js'] },
  };
}

export const rspackBundler: Bundler = {
  name: 'rspack',
  compiler(root, options, build) {
    return wrap(createRspack(root, options, build));
  },
  build(root, options, build) {
    return once(this.compiler(root, options, build));
  },
  watch(root, options, build) {
    return watchCompiler(createRspack(root, options, build));
  },
};

function createRspack(root: string, options: CompatgateBundlerOptions | undefined, build: BuildOptions = {}): Compiler {
  const config: RspackOptions = {
    ...common(root, build),
    cache:
      build.cache === 'filesystem'
        ? { type: 'persistent', storage: { type: 'filesystem', directory: join(root, '.cache') } }
        : (build.cache ?? false),
    module: { rules: rules({ loader: 'builtin:swc-loader', options: swcOptions }, build.rules) as never },
    plugins: [compatgateRspack(options), ...childCompilation(build.child, rspack.EntryPlugin)] as never,
  };
  return rspack(config) as unknown as Compiler;
}

export const webpackBundler: Bundler = {
  name: 'webpack',
  compiler(root, options, build) {
    return wrap(createWebpack(root, options, build));
  },
  build(root, options, build) {
    return once(this.compiler(root, options, build));
  },
  watch(root, options, build) {
    return watchCompiler(createWebpack(root, options, build));
  },
};

function createWebpack(
  root: string,
  options: CompatgateBundlerOptions | undefined,
  build: BuildOptions = {},
): Compiler {
  const config: Configuration = {
    ...common(root, build),
    cache:
      build.cache === 'filesystem'
        ? { type: 'filesystem', cacheDirectory: join(root, '.cache') }
        : (build.cache ?? false),
    module: { rules: rules({ loader: require.resolve('swc-loader'), options: swcOptions }, build.rules) },
    plugins: [compatgateWebpack(options), ...childCompilation(build.child, webpack.EntryPlugin)] as never,
  };
  return webpack(config) as unknown as Compiler;
}

interface ChildCompiler {
  hooks: {
    make: {
      tapAsync(
        name: string,
        run: (
          compilation: {
            createChildCompiler(
              name: string,
              output: { filename: string },
              plugins: unknown[],
            ): { runAsChild(callback: (error?: Error | null) => void): void };
          },
          callback: (error?: Error | null) => void,
        ) => void,
      ): void;
    };
  };
  context: string;
}

type EntryPlugin = new (context: string, entry: string, options: { name: string }) => unknown;

/** A plugin that builds `entry` in a child compilation of each build, or none without an entry. */
function childCompilation(entry: string | undefined, Entry: EntryPlugin): unknown[] {
  if (entry === undefined) {
    return [];
  }
  return [
    {
      apply(compiler: ChildCompiler) {
        compiler.hooks.make.tapAsync('child', (compilation, callback) => {
          const plugins = [new Entry(compiler.context, entry, { name: 'child' })];
          compilation
            .createChildCompiler('child', { filename: 'child.js' }, plugins)
            .runAsChild(error => callback(error));
        });
      },
    },
  ];
}

async function once(compiler: TestCompiler): Promise<BuildResult> {
  try {
    return await compiler.run();
  } finally {
    await compiler.close();
  }
}

interface Compiler {
  run(callback: (error: Error | null, stats?: StatsLike) => void): void;
  watch(
    options: { aggregateTimeout?: number },
    callback: (error: Error | null, stats?: StatsLike) => void,
  ): { close(callback: () => void): void };
  close(callback: (error?: Error | null) => void): void;
  hooks: {
    invalid: { tap(name: string, run: () => void): void };
    watchRun: { tap(name: string, run: () => void): void };
  };
}

interface StatsLike {
  compilation: {
    modules: Iterable<{ resource?: string; loaders?: Array<{ loader: string }> }>;
    fileDependencies: Iterable<string>;
    missingDependencies: Iterable<string>;
    children: Iterable<{ warnings: Iterable<{ message: string }> }>;
  };
  toJson(options: { all: false; errors: true; warnings: true }): {
    errors?: Array<{ message: string }>;
    warnings?: Array<{ message: string }>;
  };
}

function wrap(compiler: Compiler): TestCompiler {
  return {
    run: () =>
      new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error || !stats) {
            reject(error ?? new Error('no stats'));
            return;
          }
          resolve(resultOf(stats));
        });
      }),
    close: () => new Promise(resolve => compiler.close(() => resolve())),
  };
}

/**
 * The compiler in watch mode. `next` gives the first build that started after the last edit: an edit writes the
 * file and its time, and the second event may start a build of its own. A build that never comes fails the test
 * with a message, not the timeout of the runner.
 */
function watchCompiler(compiler: Compiler): TestWatch {
  type Result = { edits: number; result: BuildResult | Error };
  const results: Result[] = [];
  const waiting: Array<(result: Result) => void> = [];
  let edits = 0;
  let started = 0;
  let invalidated = () => {};
  compiler.hooks.invalid.tap('test', () => invalidated());
  compiler.hooks.watchRun.tap('test', () => {
    started = edits;
  });
  const watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
    const result = { edits: started, result: error || !stats ? (error ?? new Error('no stats')) : resultOf(stats) };
    const resolve = waiting.shift();
    if (resolve) {
      resolve(result);
    } else {
      results.push(result);
    }
  });
  const take = () =>
    results.shift() ??
    new Promise<Result>(resolve => {
      const timer = setTimeout(() => resolve({ edits, result: new Error('watch: no build in 10 s') }), 10_000);
      waiting.push(result => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  return {
    async next() {
      for (;;) {
        const { edits: seen, result } = await take();
        if (result instanceof Error) {
          throw result;
        }
        if (seen === edits) {
          return result;
        }
      }
    },
    async edit(path, content) {
      edits += 1;
      // The watcher starts after the first build: an edit before it would go unseen, so the edit repeats.
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const seen = new Promise<boolean>(resolve => {
          const timer = setTimeout(() => resolve(false), 200);
          invalidated = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        editFile(path, content);
        if (await seen) {
          invalidated = () => {};
          return;
        }
      }
      throw new Error(`watch: no change seen in ${path}`);
    },
    close: () =>
      new Promise(resolve => {
        watching.close(() => compiler.close(() => resolve()));
      }),
  };
}

function resultOf(stats: StatsLike): BuildResult {
  const json = stats.toJson({ all: false, errors: true, warnings: true });
  const loaders = new Map<string, string[]>();
  for (const module of stats.compilation.modules) {
    if (module.resource !== undefined && Array.isArray(module.loaders)) {
      loaders.set(
        module.resource,
        module.loaders.map(item => item.loader),
      );
    }
  }
  return {
    errors: (json.errors ?? []).map(item => item.message),
    warnings: (json.warnings ?? []).map(item => item.message),
    loaders,
    fileDependencies: new Set(stats.compilation.fileDependencies),
    missingDependencies: new Set(stats.compilation.missingDependencies),
    childWarnings: [...stats.compilation.children].flatMap(child =>
      [...child.warnings].map(warning => warning.message),
    ),
  };
}

/**
 * The messages of compatgate: `[compatgate]`, or `[compatgate/exact]` and the other confidences for a finding.
 * The bundlers add their own warnings, such as the size of the bundle.
 */
export function compatgateMessages(messages: readonly string[]): string[] {
  return messages.filter(message => COMPATGATE.test(message));
}

export const COMPATGATE = /\[compatgate(?:\/(?:exact|heuristic|partial))?\]/;
