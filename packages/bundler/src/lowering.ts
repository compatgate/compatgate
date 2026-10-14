import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ModuleFile } from './module-id.ts';

// Vite, Rolldown and esbuild lower the syntax for their target after the transforms of the plugins: the plugin
// sees a class static block that the bundle will not have. The plugin lowers a module with a syntax finding the
// same way and keeps the findings that are still there. The engines come from the project, not from the
// dependencies of the plugin: the lowering must be the one of the bundler that builds the project.

/** The code of a module after the bundler lowered its syntax, and the source map back to the checked code. */
export interface LoweredCode {
  code: string;
  /** The source map from `code` to the checked code. */
  map?: unknown;
}

/**
 * Lowers the syntax of a module as the bundler does after the transforms of the plugins. Gives `null` when the
 * target of the bundler keeps every syntax.
 */
export type Lower = (code: string, file: ModuleFile) => Promise<LoweredCode | null>;

/** Whether a target of a bundler lowers some syntax. No target and `esnext` keep all of it. */
function lowersSyntax(target: unknown): boolean {
  const items: unknown[] = Array.isArray(target) ? target : [target];
  return items.some(item => typeof item === 'string' && item.trim() !== '' && item.trim().toLowerCase() !== 'esnext');
}

/**
 * The engine of the lowering is missing: the project does not resolve it, or it fails to load. The findings stay,
 * and the plugin warns once per build: without the warning a syntax finding would look like a bug of the plugin.
 */
export class LoweringEngineError extends Error {
  override name = 'LoweringEngineError';
}

const projectModules = new Map<string, Promise<unknown>>();

/**
 * Loads a module of the bundler as the project resolves it: from `root`, else from the process directory, where
 * a bundler usually runs. Throws `LoweringEngineError` that names the bundler.
 *
 * A failed load stays in the cache for the life of the process, by design: the next modules fail at once, and the
 * plugin warns once per build. An engine installed while a watch build or a dev server runs needs a restart.
 */
function importFromProject<T>(bundler: string, root: string, specifier: string): Promise<T> {
  const key = `${root}\0${specifier}`;
  let loading = projectModules.get(key);
  if (!loading) {
    loading = (async () => {
      const path = resolveFrom([root, process.cwd()], specifier);
      return import(pathToFileURL(path).href);
    })();
    projectModules.set(key, loading);
  }
  return (loading as Promise<T>).catch((error: unknown) => {
    throw engineError(bundler, error instanceof Error ? error.message : String(error));
  });
}

function engineError(bundler: string, cause: string): LoweringEngineError {
  const firstLine = cause.split('\n')[0] ?? cause;
  return new LoweringEngineError(`cannot lower as ${bundler} does: ${firstLine}; syntax findings stay`);
}

function resolveFrom(directories: readonly string[], specifier: string): string {
  let failure: unknown;
  for (const directory of directories) {
    try {
      return createRequire(join(directory, 'package.json')).resolve(specifier);
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure;
}

type Options = Record<string, unknown>;

// The options of the Oxc transformer that change the lowering. `define`, `inject` and `dropLabels` change other
// code, and the lowered code is only checked.
const OXC_OPTIONS = ['assumptions', 'typescript', 'decorator', 'helpers', 'plugins'];

function oxcOptions(transform: Options): Options {
  return Object.fromEntries(OXC_OPTIONS.filter(key => transform[key] !== undefined).map(key => [key, transform[key]]));
}

/** The `jsx` option of Rolldown in the form of the Oxc transformer. */
function oxcJsx(jsx: unknown): unknown {
  if (jsx === 'react') {
    return { runtime: 'classic' };
  }
  if (jsx === 'react-jsx') {
    return { runtime: 'automatic' };
  }
  return jsx === 'preserve' || (typeof jsx === 'object' && jsx !== null) ? jsx : undefined;
}

interface OxcResult {
  code: string;
  map?: unknown;
  errors?: unknown[];
}

/** The parts of a Vite environment that the lowering needs. */
export interface ViteEnvironment {
  config: {
    root: string;
    consumer?: string;
    tsconfig?: unknown;
    build: { target?: unknown; rolldownOptions?: { transform?: Options; tsconfig?: unknown } };
  };
  getTopLevelConfig?(): unknown;
}

/**
 * The lowering of Vite 8: Rolldown lowers each module for `transform.target`, which is `build.target` unless
 * `rolldownOptions.transform` sets it. The dev server lowers nothing, and the plugin lowers as the build of the
 * environment would: a finding that the build lowers is no error in the dev server either.
 */
export function viteLower(environment: ViteEnvironment | undefined): Lower | undefined {
  if (!environment) {
    return undefined;
  }
  const { config } = environment;
  const transform = config.build.rolldownOptions?.transform ?? {};
  const target = 'target' in transform ? transform.target : config.build.target;
  if (!lowersSyntax(target)) {
    return undefined;
  }
  return async (code, file) => {
    const vite = await importFromProject<{
      transformWithOxc(
        code: string,
        filename: string,
        options: Options,
        map: undefined,
        config: unknown,
      ): Promise<OxcResult>;
    }>('Vite', config.root, 'vite');
    // Vite before 8 has no `transformWithOxc`. The error of the engine warns once per build; a TypeError would
    // turn the lowering off without a word, and a lowered syntax would fail the build.
    if (typeof vite.transformWithOxc !== 'function') {
      throw engineError('Vite', 'Vite 8 or later is needed for the lowering check');
    }
    // The transforms of Vite have made the module JavaScript already. Without a tsconfig of the options Vite
    // resolves the tsconfig.json of the file through its cache, as its own transforms do.
    const tsconfig = config.tsconfig ?? config.build.rolldownOptions?.tsconfig;
    const options = {
      ...oxcOptions(transform),
      lang: 'js',
      target,
      ...(tsconfig === undefined ? {} : { tsconfig }),
    };
    const result = await vite.transformWithOxc(
      code,
      file.parseAs ?? file.path,
      options,
      undefined,
      environment.getTopLevelConfig?.(),
    );
    return { code: result.code, map: result.map };
  };
}

/** The input options of Rolldown that the lowering needs. */
export interface RolldownOptions {
  cwd?: string;
  tsconfig?: unknown;
  transform?: Options;
}

/** The lowering of Rolldown: after the transforms it removes the types and lowers the syntax for `transform.target`. */
export function rolldownLower(options: RolldownOptions | undefined): Lower | undefined {
  const transform = options?.transform ?? {};
  if (!lowersSyntax(transform.target)) {
    return undefined;
  }
  const cwd = options?.cwd ?? process.cwd();
  return async (code, file) => {
    const utils = await importFromProject<{
      transformSync(filename: string, code: string, options: Options): OxcResult;
    }>('Rolldown', cwd, 'rolldown/utils');
    const result = utils.transformSync(file.parseAs ?? file.path, code, {
      ...oxcOptions(transform),
      jsx: oxcJsx(transform.jsx),
      target: transform.target,
      tsconfig: options?.tsconfig ?? true,
      cwd,
      sourcemap: true,
    });
    if (result.errors && result.errors.length > 0) {
      throw result.errors[0];
    }
    return { code: result.code, map: result.map };
  };
}

/** The build options of esbuild that the lowering needs. */
export interface EsbuildOptions {
  target?: string | string[];
  supported?: Record<string, boolean>;
  tsconfig?: string;
  tsconfigRaw?: string | object;
  absWorkingDir?: string;
  jsx?: string;
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  jsxDev?: boolean;
  jsxSideEffects?: boolean;
}

const ESBUILD_JSX_OPTIONS = [
  'jsx',
  'jsxFactory',
  'jsxFragment',
  'jsxImportSource',
  'jsxDev',
  'jsxSideEffects',
] as const;

interface Esbuild {
  transform(code: string, options: Options): Promise<{ code: string; map: string }>;
}

/**
 * The lowering of esbuild: after `onLoad` it lowers the syntax for `target` and `supported`. `esbuild` is the
 * esbuild of the build that runs the plugin.
 */
export function esbuildLower(
  options: EsbuildOptions | undefined,
  esbuild: Esbuild | undefined,
  loader: (path: string) => string,
  tsconfigs: TsconfigCache,
): Lower | undefined {
  if (!options) {
    return undefined;
  }
  const supported = options.supported && Object.keys(options.supported).length > 0 ? options.supported : undefined;
  if (!lowersSyntax(options.target) && !supported) {
    return undefined;
  }
  return async (code, file) => {
    if (!esbuild) {
      throw engineError('esbuild', 'the build gives no esbuild to its plugins');
    }
    const jsx = Object.fromEntries(
      ESBUILD_JSX_OPTIONS.filter(key => options[key] !== undefined).map(key => [key, options[key]]),
    );
    const result = await esbuild.transform(code, {
      ...jsx,
      loader: loader(file.path),
      target: options.target,
      supported,
      tsconfigRaw: esbuildTsconfig(options, file.path, tsconfigs),
      sourcefile: file.path,
      sourcemap: true,
    });
    return { code: result.code, map: JSON.parse(result.map) as unknown };
  };
}

/**
 * The text of the nearest tsconfig.json of each directory, for the lowering of esbuild. The plugin clears it at
 * the start of each build, so an edit shows in the next build of watch mode.
 */
export type TsconfigCache = Map<string, string | undefined>;

// The transform API of esbuild reads no tsconfig.json, while a build reads the nearest one. Its settings, such
// as `useDefineForClassFields` and `experimentalDecorators`, change the lowered code. The plugin gives the text
// of the file as `tsconfigRaw` and does not follow its `extends`.
function esbuildTsconfig(options: EsbuildOptions, path: string, cache: TsconfigCache): string | object | undefined {
  if (options.tsconfigRaw !== undefined) {
    return options.tsconfigRaw;
  }
  if (options.tsconfig !== undefined) {
    return readText(resolve(options.absWorkingDir ?? process.cwd(), options.tsconfig));
  }
  const directory = dirname(path);
  if (!cache.has(directory)) {
    const file = nearestTsconfig(directory);
    cache.set(directory, file === undefined ? undefined : readText(file));
  }
  return cache.get(directory);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function nearestTsconfig(start: string): string | undefined {
  for (let directory = start; ; directory = dirname(directory)) {
    const file = join(directory, 'tsconfig.json');
    if (existsSync(file)) {
      return file;
    }
    if (dirname(directory) === directory) {
      return undefined;
    }
  }
}
