import { TRANSFORM_FILTER, moduleFile, moduleFileOf, type ModuleFile } from '../module-id.ts';
import { sourceMapLocate } from '../source-map.ts';
import type { ModuleContext } from '../state.ts';
import { label } from '../summary.ts';
import type { BuildEnd, GraphModule, Host, HookContext } from './host.ts';
import { pluginChannels } from './plugin-context.ts';

// webpack and rspack run the transform of unplugin in a loader. They differ only in the project root of the
// options, so both hosts are this one with their own `root`.

/** The native context of webpack and rspack. */
function nativeOf(context: HookContext) {
  const native = context.getNativeBuildContext?.();
  return native?.framework === 'webpack' || native?.framework === 'rspack' ? native : undefined;
}

type Loader = NonNullable<NonNullable<ReturnType<typeof nativeOf>>['loaderContext']>;

/** A compilation of webpack or rspack, as far as the plugin needs it. */
interface LoaderCompilation {
  warnings: Error[];
  modules: Iterable<CompilationModule>;
  /** The modules that the compilation built, not took from a cache: a `WeakSet` in webpack, a `Set` in rspack. */
  builtModules?: { has(module: CompilationModule): boolean };
}

/** A module of a compilation of webpack or rspack, as far as the plugin needs it. */
interface CompilationModule {
  /** The id of the module in the compilation: the resource with the loaders and the layer. */
  identifier?: unknown;
  resource?: unknown;
  /** The resource that the rules of the loaders match, such as `App.vue.ts` of `App.vue.ts!=!…`. */
  matchResource?: unknown;
  resourceResolveData?: { path?: unknown; query?: unknown } | undefined;
  /** The inner modules of a concatenated module. */
  modules?: Iterable<CompilationModule>;
}

export function loaderHost(root: Host['root']): Host {
  return {
    root,
    // webpack and rspack give the path and the query apart: the id joins them, and a `#` in a directory name
    // would look like a hash.
    file(context, id) {
      const loader = nativeOf(context)?.loaderContext;
      return loader ? moduleFileOf(loader.resourcePath, loader.resourceQuery) : moduleFile(id);
    },
    // The source map of the loaders before compatgate. A loader gives it only when the build makes source maps.
    locate(context, file) {
      const native = nativeOf(context);
      return sourceMapLocate(file, () => native?.inputSourceMap);
    },
    lower: () => undefined,
    channels(context, errors) {
      const native = nativeOf(context);
      const loader = native?.loaderContext;
      const compilation = native?.compilation as LoaderCompilation | undefined;
      return loader ? loaderChannels(loader, compilation) : pluginChannels(context, errors, false);
    },
    // A module keeps its warnings, and a cache gives them again: the summary replaces them at the end. A child
    // compilation, such as the one of html-webpack-plugin, keeps its own warnings, and the end of the build
    // sees only the warnings of the main compilation: the findings of a child stay one by one, and its records
    // stay out of the graph of the main compilation. The loader of unplugin gives the compilation of the module,
    // so the compiler of the module tells a child apart.
    reports: {
      partial: context => (isChild(context) ? 'show' : 'record'),
      inGraph: context => !isChild(context),
      key: (context, id) => identifierOf(nativeOf(context)?.loaderContext?._module) ?? id,
      end(context): BuildEnd | null {
        const compilation = nativeOf(context)?.compilation as LoaderCompilation | undefined;
        if (!compilation) {
          return null;
        }
        return {
          partial: 'record',
          modules: () => graphModules(compilation.modules, compilation.builtModules),
          // The context of the end of a build has no `warn` in webpack and rspack.
          warn: messages => compilation.warnings.push(...messages.map(bundlerError)),
          retract: texts => removeWarnings(compilation.warnings, texts),
        };
      },
    },
  };
}

/**
 * The identifier of a module: one resource makes two modules with other loaders, such as by a rule of the issuer,
 * or in other layers. The loader of the transform and the compilation give the same string.
 */
function identifierOf(module: unknown): string | undefined {
  const identifier = (module as CompilationModule | undefined)?.identifier;
  const value: unknown = typeof identifier === 'function' ? identifier.call(module) : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Whether the module of a transform belongs to a child compilation. */
function isChild(context: HookContext): boolean {
  const compiler = nativeOf(context)?.compiler as { isChild?: unknown } | undefined;
  return typeof compiler?.isChild === 'function' && compiler.isChild() === true;
}

/**
 * The channels of a module of webpack and rspack: an error of a module fails the build at its end, and the build
 * goes on, so one build shows every error.
 */
function loaderChannels(loader: Loader, compilation: LoaderCompilation | undefined): ModuleContext {
  return {
    error: message => loader.emitError(bundlerError(message)),
    warn: message => loader.emitWarning(bundlerError(message)),
    warnBuild: message =>
      compilation ? compilation.warnings.push(bundlerError(message)) : loader.emitWarning(bundlerError(message)),
    addWatchFile: path => loader.addDependency(path),
    addMissingFile: path => loader.addMissingDependency(path),
  };
}

// webpack prints the stack of an error under its message. A stack of the plugin tells nothing about the module.
function bundlerError(message: string): Error {
  const error = new Error(message);
  error.stack = message;
  return error;
}

/**
 * The modules of a compilation, as the transform would see them. A module passes to the transform when its rule
 * resource passes the filter of the hook, as in the loader rule of unplugin.
 */
function* graphModules(
  modules: Iterable<CompilationModule>,
  built: LoaderCompilation['builtModules'],
): Generator<GraphModule> {
  for (const module of modules) {
    // rspack replaces the root module of a concatenation with the concatenated module.
    if (module.modules) {
      yield* graphModules(module.modules, built);
    }
    // A field of a module of rspack is a call into the bundler: each is read once.
    const { resource } = module;
    if (typeof resource !== 'string') {
      continue;
    }
    yield {
      id: identifierOf(module) ?? resource,
      file: () => {
        const rule = module.matchResource ?? resource;
        const passes =
          typeof rule === 'string' && TRANSFORM_FILTER.include.test(rule) && !TRANSFORM_FILTER.exclude.test(rule);
        return passes ? compilationModuleFile(module) : null;
      },
      // Without the list of the built modules a record of older code would pass for one of this build.
      built: () => built?.has(module) ?? true,
    };
  }
}

/** The file of a module of webpack or rspack, as the transform would see it. */
function compilationModuleFile(module: CompilationModule): ModuleFile | null {
  const data = module.resourceResolveData;
  if (typeof data?.path === 'string') {
    return moduleFileOf(data.path, typeof data.query === 'string' ? data.query : '');
  }
  return typeof module.resource === 'string' ? moduleFile(module.resource) : null;
}

/**
 * Removes the warnings of the modules that a summary gives. webpack and rspack put the name of the loader before
 * the text of a warning of a module, and both name such a warning `ModuleWarning`.
 */
function removeWarnings(warnings: Error[], texts: ReadonlySet<string>): void {
  if (texts.size === 0) {
    return;
  }
  // In rspack each read of an item of the list is a call into the bundler: the list is read once.
  const all = warnings.slice();
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const warning = all[index];
    const message = warning?.message ?? '';
    const start = message.indexOf(label('partial'));
    // A warning of the build with the same text, of another plugin, stays.
    if (start !== -1 && texts.has(message.slice(start).trimEnd()) && warning?.name === 'ModuleWarning') {
      warnings.splice(index, 1);
    }
  }
}
