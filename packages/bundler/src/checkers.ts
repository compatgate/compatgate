import type { CheckResult, Checker, Configuration } from '@compatgate/core';

import type { ModuleFile } from './module-id.ts';

/** The messages about the configs of a configuration: the errors of a build and the warnings of the process. */
export interface ConfigurationMessages {
  readonly errors: readonly string[];
  /** `key` tells the warnings of the process apart: it names the config by its absolute path. */
  readonly warnings: readonly { readonly key: string; readonly message: string }[];
}

/** Checks a module. The record of the module, with the entries that it used, is up to the caller. */
export function checkFile(configuration: Configuration, source: string, file: ModuleFile): CheckResult {
  // `path` matches the `files` of the entries, `parseAs` only selects the parser of a component.
  return configuration.checker.check(source, file.path, file.parseAs);
}

/** What the plugin keeps for a checker of the core. */
interface CheckerState {
  /** The configuration that the modules of the checker share: the first that the registry got. */
  readonly configuration: Configuration;
  /**
   * The messages about the configs. The plugin makes them on the first module of the configuration, and each module
   * of the configuration gives them again: the frequency of a message decides whether it shows.
   */
  messages: ConfigurationMessages | undefined;
  /** Whether a module of the current build took the configuration. */
  active: boolean;
}

/**
 * One configuration per checker of the core. The core gives the directories with the same configs one checker, but
 * a new configuration object for each directory: the modules of a checker share the first one here, and its
 * messages. The report of unused entries tells the configurations apart by identity.
 *
 * The bundler does not call `check()` of the core: the report of unused entries needs to know which list the
 * indexes of `suppressed` point into.
 */
export class CheckerRegistry {
  // A Map, not a WeakMap: the start of a build walks it to drop the checkers of the last build.
  private readonly cache = new Map<Checker, CheckerState>();

  /** The configuration of the checker of `resolved` for a module: the current build takes the checker. */
  configuration(resolved: Configuration): Configuration {
    const state = this.state(resolved);
    state.active = true;
    return state.configuration;
  }

  /**
   * The messages about the configs of a configuration: `make` gives them on the first call. The build does not take
   * the checker by this call: only a module does, through `configuration`.
   */
  messages(configuration: Configuration, make: () => ConfigurationMessages): ConfigurationMessages {
    const state = this.state(configuration);
    state.messages ??= make();
    return state.messages;
  }

  private state(resolved: Configuration): CheckerState {
    let state = this.cache.get(resolved.checker);
    if (!state) {
      state = { configuration: resolved, messages: undefined, active: false };
      this.cache.set(resolved.checker, state);
    }
    return state;
  }

  /** @internal — tests only. The number of configurations that keep a checker. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Starts a build. A configuration that no module of the last build took is dropped, so the edits of
   * compatgate.jsonc in watch mode do not pile up checkers. A record of a module from a cache keeps its configuration
   * on its own.
   */
  startBuild(): void {
    for (const [checker, state] of this.cache) {
      if (state.active) {
        state.active = false;
      } else {
        this.cache.delete(checker);
      }
    }
  }
}
