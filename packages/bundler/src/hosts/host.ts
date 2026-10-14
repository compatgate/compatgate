import type { UnpluginBuildContext, UnpluginContext, UnpluginContextMeta, UnpluginOptions } from 'unplugin';

import type { PartialMode } from '../check.ts';
import type { Lower } from '../lowering.ts';
import type { ModuleFile } from '../module-id.ts';
import type { Locate } from '../source-map.ts';
import type { ModuleContext, PluginState } from '../state.ts';

// A host is one bundler as the plugin sees it. The shared pipeline (`../pipeline.ts`) asks the host for each
// property that differs between the bundlers, and never asks which bundler it runs in. A new bundler is a new
// host file and a row of the table in `index.ts`. The model is in `docs/model.md`.

/** The context of a hook of unplugin. */
export type HookContext = UnpluginBuildContext & UnpluginContext;

/** The context of the end of a build, with the members that only some bundlers give. */
export type BuildEndContext = HookContext & {
  warn?: (message: string) => void;
  getWatchFiles?: () => string[];
  getModuleIds?: () => Iterable<string>;
  getModuleInfo?: (id: string) => { isExternal?: boolean; code?: string | null } | null;
};

/** A module of the graph of a build, as the transform would see it. */
export interface GraphModule {
  /** The key of the record of the module: `HostReports.key` of its transform. */
  readonly id: string;
  /**
   * The file that the transform would check, before `include` and `exclude`, or `null` when no transform of the
   * plugin sees the module. A call, not a field: a field of a module of rspack is a call into the bundler, and
   * the records pass most modules before it.
   */
  file(): ModuleFile | null;
  /**
   * Whether the bundler built the module in this build, not took it from a cache. A module that the bundler built
   * without the transform of compatgate failed in another loader, and its record is of older code. Absent: a
   * bundler where such a failure fails the build.
   */
  built?(): boolean;
}

interface BuildEndBase {
  /**
   * The modules of the graph of the build, or `null` when the bundler gives no list, as for a failed build. The
   * plugin walks the list only when it has something to report.
   */
  modules(): Iterable<GraphModule> | null;
  /** Gives the messages as warnings of the build, in their order. */
  warn(messages: readonly string[]): void;
}

/**
 * The end of a build: the list of its modules and the way to warn. `partial` tells what the modules did with
 * their partial findings: `record` showed them, and the end takes them back for a summary; `hold` kept them,
 * and the end shows them.
 */
export type BuildEnd =
  | (BuildEndBase & { readonly partial: 'record'; retract(texts: ReadonlySet<string>): void })
  | (BuildEndBase & { readonly partial: 'hold' });

/** The reports at the end of a build of a host. */
export interface HostReports {
  /** What a module does with a partial finding of the level `warn`. */
  partial(context: HookContext): PartialMode;
  /**
   * The key of the record of the module of a transform. Two modules of one file, with other loaders or in other
   * layers of webpack, need two keys. Absent: the id of the transform.
   */
  key?(context: HookContext, id: string): string;
  /**
   * Whether the module belongs to the graph that the end of the build walks. A module of a child compilation of
   * webpack does not: its record stays apart, and its entries count as used. Absent: every module does.
   */
  inGraph?(context: HookContext): boolean;
  /**
   * The end of a build. `null`: the bundler gives the end no way to warn. A host that holds the partial findings
   * needs one: the plugin throws then, as the held findings would be lost.
   */
  end(context: BuildEndContext, failed: boolean): BuildEnd | null;
}

/** The hooks of unplugin that belong to one bundler. */
export type HostHooks = Pick<UnpluginOptions, 'vite' | 'esbuild' | 'rolldown' | 'rollup'>;

/**
 * The properties of one bundler: one function per column of the host table. A host instance serves one plugin
 * instance, so it may keep the options of its build.
 */
export interface Host {
  /** The project root before the build gives its own: `compiler.context`, or the process directory. */
  root(meta: UnpluginContextMeta): string;
  /** The file of the module of a transform. */
  file(context: HookContext, id: string): ModuleFile | null;
  /** Positions: the way from the checked code to the source. */
  locate(context: HookContext, file: ModuleFile): Locate | undefined;
  /** Lowering: the lowering of the bundler after the transforms, or `undefined` when it has none. */
  lower(context: HookContext): Lower | undefined;
  /**
   * Errors and new configs: where the messages of one module go, and how the bundler watches the configs of the
   * module, a missing one too. An error that the bundler reports at the end of the build goes to `errors`.
   */
  channels(context: HookContext, errors: string[]): ModuleContext;
  /**
   * The list of modules: the reports at the end of a build, the summary of partial findings and the report of
   * unused entries. A host without them shows each finding with its module.
   */
  reports?: HostReports;
  /**
   * Whether the build has no end, as in the dev server of Vite: a module reports its own errors, the configs are
   * checked for each module, and there are no reports at the end. A call: Vite tells it when its config resolves.
   * Absent: the build has an end.
   */
  endless?(): boolean;
  /** Reads the options of a build when it starts, such as the root of the project. */
  buildStart?(state: PluginState, options: unknown): void;
  /** The hooks that only this bundler calls. */
  hooks?(state: PluginState): HostHooks;
}
