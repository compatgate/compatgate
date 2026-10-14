import type { Configuration } from '@compatgate/core';

import type { GraphModule } from './hosts/host.ts';
import type { ModuleFile } from './module-id.ts';
import type { PartialFinding } from './summary.ts';

/** What the check of one module leaves for the reports at the end of a build. */
export interface ModuleRecord {
  /** The configuration that checked the module, or `null` when its configs have an error. */
  readonly configuration: Configuration | null;
  /** The indexes of `configuration.entries` that the module needs. */
  readonly used: readonly number[];
  /** The partial findings of the level `warn` that the summary takes, in the order of the module. */
  readonly partials: readonly PartialFinding[];
}

/**
 * The records of the modules, for the reports at the end of a build (table D of `docs/model.md`). A record lives
 * for the plugin instance, not for one build: a module that a watch build takes from a cache keeps the record of
 * the build that checked it. A new check of a module replaces its record: a change of its code, or of its configs,
 * which the bundler watches for the module.
 */
export class ModuleRecords {
  /** By the id of the module: the modules of the graph that the end of a build walks. */
  private graph = new Map<string, ModuleRecord>();
  /**
   * The modules outside that graph, such as a module of a child compilation of webpack. Their entries count as
   * used, and the walk neither needs nor drops them.
   */
  private readonly outside = new Map<string, ModuleRecord>();
  /** The ids of the modules of the graph that the transform recorded in this build. */
  private readonly current = new Set<string>();
  /** The ids of the modules outside the graph that the transform recorded in this build. */
  private readonly currentOutside = new Set<string>();

  startBuild(): void {
    this.current.clear();
    this.currentOutside.clear();
  }

  set(id: string, record: ModuleRecord, inGraph: boolean): void {
    if (inGraph) {
      this.graph.set(id, record);
      this.current.add(id);
    } else {
      this.outside.set(id, record);
      this.currentOutside.add(id);
    }
  }

  /**
   * Drops the records that this build set: the build failed. Rollup keeps the cache of the build before a failed
   * one, so the next build may take the code before the failed build from it, without the transform. A record of
   * the failed build would pass for a record of that code. Without a record the next report is incomplete.
   */
  dropBuild(): void {
    for (const id of this.current) {
      this.graph.delete(id);
    }
    for (const id of this.currentOutside) {
      this.outside.delete(id);
    }
    this.startBuild();
  }

  /**
   * Whether every record of the graph is of this build. An older record may belong to a module that left the
   * graph: only a walk over the graph tells.
   */
  fresh(): boolean {
    return this.graph.size === this.current.size;
  }

  /** The records of the graph, older ones included. */
  graphRecords(): Iterable<ModuleRecord> {
    return this.graph.values();
  }

  /** The records outside the graph. */
  outsideRecords(): Iterable<ModuleRecord> {
    return this.outside.values();
  }

  /** Every record: of the graph, older ones included, and outside it. */
  *all(): Iterable<ModuleRecord> {
    yield* this.graph.values();
    yield* this.outside.values();
  }

  /**
   * The records of the modules of the graph, or `null` when a module that the plugin checks has no record of its
   * code. `null` modules: the bundler gives no list. The walk covers the whole graph and drops the records of the
   * modules that left it, complete or not: the records take no more memory than the graph.
   */
  collect(
    modules: Iterable<GraphModule> | null,
    select: (file: ModuleFile | null) => ModuleFile | null,
  ): ModuleRecord[] | null {
    if (modules === null) {
      return null;
    }
    const found = new Map<string, ModuleRecord>();
    let complete = true;
    for (const module of modules) {
      const record = this.recordOf(module);
      if (record) {
        found.set(module.id, record);
      } else if (complete && select(module.file())) {
        complete = false;
      }
    }
    this.graph = found;
    return complete ? [...found.values()] : null;
  }

  /**
   * The record of the code of a module in this build. The bundler builds a module again on a change of its code
   * or of its configs, and the transform replaces the record then. A module that the bundler built in this build
   * without the transform failed in another loader: its record is of older code.
   */
  private recordOf(module: GraphModule): ModuleRecord | undefined {
    if (!this.current.has(module.id) && module.built?.()) {
      return undefined;
    }
    return this.graph.get(module.id);
  }
}
