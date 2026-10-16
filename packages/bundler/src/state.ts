import {
  ConfigError,
  createResolver,
  type AllowEntry,
  type AllowSource,
  type Configuration,
  type FindingConfidence,
  type Resolver,
  type SharedOptions,
} from '@compatgate/core';

import { CheckerRegistry, type ConfigurationMessages } from './checkers.ts';
import type { ModuleFile } from './module-id.ts';
import { WHERE, createFilter, readOptions, toPosix, type CompatgateBundlerOptions, type Level } from './options.ts';
import { ModuleRecords, type ModuleRecord } from './records.ts';
import type { PartialFinding } from './summary.ts';

/** What the plugin needs from the bundler while it checks one module. */
export interface ModuleContext {
  error(message: string): void;
  warn(message: string): void;
  /**
   * A warning of the build, not of the module: webpack and rspack keep the warnings of a module with it, and
   * give them again with each build that takes the module from a cache. Default: `warn`.
   */
  warnBuild?(message: string): void;
  /** Makes the bundler check the module again when the file changes: a config of the module. */
  addWatchFile(path: string): void;
  /** Makes the bundler check the module again when the file appears. */
  addMissingFile(path: string): void;
}

/**
 * How often a message shows. `module`: on each module that gives it. `build`: once per build, as every module would
 * repeat a problem of the setup. `process`: once per process, as a watch build, a cache and a second compiler of the
 * same config would repeat a warning about the config.
 */
export type Scope = 'module' | 'build' | 'process';

// The keys of the messages that the process has shown.
const processMessages = new Set<string>();

/** @internal — tests only. Lets the messages of the process show again: tests run many builds of one config. */
export function clearProcessMessages(): void {
  processMessages.clear();
}

/** The state of one plugin instance. A watch build starts with `startBuild`. */
export class PluginState {
  readonly registry = new CheckerRegistry();
  readonly severity: Readonly<Record<FindingConfidence, Level>>;
  /**
   * The errors of the build, for the bundlers that report them at its end: Rollup, Rolldown, esbuild and the
   * build of Vite. A thrown error would stop the build at the first module.
   */
  readonly errors: string[] = [];
  /** The keys of the messages that this build has shown. */
  private readonly buildMessages = new Set<string>();
  /**
   * The partial findings of the level `warn` that the modules of this build held. The end of a build that cannot
   * make the summary shows them one by one.
   */
  readonly partials: PartialFinding[] = [];
  /** The configs of the modules of the dev server: an edit of one gives the modules a new configuration. */
  private readonly configFiles = new Set<string>();
  /** The places of a new config that the modules of this build watch: see `endBuild`. */
  readonly missingFiles = new Set<string>();
  /** The records of the modules, for the reports at the end of a build. They live for the plugin instance. */
  readonly records = new ModuleRecords();
  /**
   * The core checks the configs at the first module of a build, not at each module. The dev server has one build for
   * its whole life: a change of any file starts a new snapshot instead, as the dev server checks the modules of a
   * changed config again right after the change.
   */
  private snapshot: object = {};
  /** The resolver of the configurations for the project root: a host may set the root after the plugin is made. */
  private resolver: { readonly baseDir: string; readonly resolver: Resolver };
  private filter: { baseDir: string; test: (path: string) => boolean } | undefined;

  readonly options: CompatgateBundlerOptions;
  /** The options that select the targets and the entries, as the core checked them. */
  private readonly shared: SharedOptions;
  /** The project root: relative paths of the options resolve against it, and messages show paths relative to it. */
  baseDir: string;
  /**
   * Whether the build has no end, as in the dev server of Vite: `buildStart` runs once, when the server starts,
   * and a module reports its own errors. `Host.endless` of the host tells it.
   */
  private readonly endless: () => boolean;

  constructor(options: CompatgateBundlerOptions, baseDir: string, endless: () => boolean = () => false) {
    this.options = options;
    this.baseDir = baseDir;
    this.endless = endless;
    const { shared, severity } = readOptions(options);
    this.shared = shared;
    this.severity = severity;
    // The core checks the shared options here, when the plugin is made, and not at the first module.
    this.resolver = { baseDir, resolver: createResolver({ ...shared, baseDir, where: WHERE }) };
  }

  startBuild(): void {
    this.registry.startBuild();
    this.buildMessages.clear();
    this.errors.length = 0;
    this.partials.length = 0;
    this.records.startBuild();
    this.missingFiles.clear();
    this.snapshot = {};
  }

  /** Calls `emit` unless a message with the key has shown in the scope. */
  once(scope: Scope, key: string, emit: () => void): void {
    if (scope !== 'module') {
      const shown = scope === 'build' ? this.buildMessages : processMessages;
      if (shown.has(key)) {
        return;
      }
      shown.add(key);
    }
    emit();
  }

  /**
   * The scope of an error of a config. The dev server answers each module apart: a module without the error would
   * pass unchecked. Its build lasts for the life of the server, so a build scope would show the error once.
   */
  private get configErrors(): Scope {
    return this.endless() ? 'module' : 'build';
  }

  /**
   * A file of the project changed in the dev server: the next modules check their configs again. An edit of a config
   * gives the modules a new configuration, so the configurations that no module used since the last edit go: a
   * checker of each old version of compatgate.jsonc would stay for the life of the server.
   */
  fileChanged(path: string): void {
    if (!this.endless()) {
      return;
    }
    this.snapshot = {};
    // Vite gives `/` separators on Windows too.
    if (this.configFiles.has(toPosix(path))) {
      this.registry.startBuild();
    }
  }

  /** The file of a module that the plugin checks, or `null`. */
  select(file: ModuleFile | null): ModuleFile | null {
    return file && this.matches(file.path) ? file : null;
  }

  /**
   * Finds the configuration of a module and makes the bundler watch its configs. A config error goes to
   * `context`, and gives `null`.
   */
  configuration(path: string, context: ModuleContext): Configuration | null {
    try {
      const resolved = this.currentResolver().resolve(path, { snapshot: this.snapshot });
      this.watch(context, resolved);
      const configuration = this.registry.configuration(resolved);
      this.report(configuration, context);
      this.warnIgnored(resolved, context);
      return configuration;
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      // A fix of the broken config must check the module again: the error names the configs to watch.
      this.watch(context, error);
      this.once(this.configErrors, error.message, () => context.error(`[compatgate] ${error.message}`));
      return null;
    }
  }

  // The watched files are dependencies of the module: webpack and rspack keep them with the module and take it from
  // a cache by them, so each module registers its configs. A module of a dependency takes the configs of the
  // project: a config of the dependency is not watched.
  private watch(context: ModuleContext, files: { watch?: readonly string[]; missing?: readonly string[] }): void {
    for (const file of files.watch ?? []) {
      context.addWatchFile(file);
      if (this.endless()) {
        // Vite gives `/` separators on Windows too.
        this.configFiles.add(toPosix(file));
      }
    }
    for (const file of files.missing ?? []) {
      context.addMissingFile(file);
      this.missingFiles.add(file);
    }
  }

  /**
   * Reports the problems of the configs of a configuration that need no code. The report comes with the modules,
   * not at the start of the build: a module finds its targets and its compatgate.jsonc, so the configurations of a
   * build are known only from its modules.
   */
  private report(configuration: Configuration, context: ModuleContext): void {
    const messages = this.registry.messages(configuration, () => this.messages(configuration));
    for (const message of messages.errors) {
      this.once(this.configErrors, message, () => context.error(message));
    }
    for (const { key, message } of messages.warnings) {
      this.once('process', key, () => (context.warnBuild ?? context.warn)(message));
    }
  }

  /**
   * An unknown id of the project is an error, so neither a watch build nor a cache passes the config. An unknown id
   * of a base is a warning: a list shared by many projects may name a feature of a newer compatgate. An entry for a
   * feature of every target is a warning, and the entries of a base are left out: such a list is wider than any of
   * its projects.
   */
  private messages(configuration: Configuration): ConfigurationMessages {
    const errors: string[] = [];
    const warnings: { key: string; message: string }[] = [];
    for (const issue of configuration.issues) {
      const entry = configuration.entries[issue.index];
      const own = entry?.origin === 'own';
      if (entry === undefined || (issue.kind === 'native-in-targets' && !own)) {
        continue;
      }
      const message = `[compatgate] ${issue.message}`;
      if (own && issue.kind === 'unknown-feature') {
        errors.push(message);
      } else {
        // The absolute path of the source tells two projects of one process apart.
        warnings.push({ key: JSON.stringify([entry.source, issue.kind, entry.feature]), message });
      }
    }
    return { errors, warnings };
  }

  /**
   * The warning about the browsers without data. It takes the configuration of the module, not the one of its
   * checker: the configurations of a checker select the same browsers, but by the queries of their directories.
   */
  private warnIgnored(configuration: Configuration, context: ModuleContext): void {
    const ignored = configuration.ignoredBrowsers;
    if (ignored.length > 0) {
      const message =
        `[compatgate] targets "${configuration.targets}" name browsers that compatgate has no data for: ` +
        `${ignored.join(', ')}. compatgate does not check them`;
      this.once('process', message, () => (context.warnBuild ?? context.warn)(message));
    }
  }

  /**
   * The own entries that no module of the records needs: one warning per config. Only the configurations of
   * `records` give the entries to report. `alsoUsed`, such as the records of a child compilation, only marks
   * entries as used. An entry counts as used when it suppressed a finding with any configuration of its config, as a
   * config serves modules with other targets too, and when a config that extends it needed it. An entry with an
   * unknown id or a feature of every target is reported at the start already. A record without a configuration is
   * of a module whose configs have an error: the entries that it needs are unknown, so no entry is reported. The
   * entries of a config that the records hold in two versions where an index names another feature are not reported
   * either: a change of the config between two modules gives them, and the report could name an entry that the
   * config no longer has. A change of only `files` or `packages` keeps the report: the entry suppressed no finding in
   * either version.
   */
  unusedEntries(records: Iterable<ModuleRecord>, alsoUsed: Iterable<ModuleRecord> = []): string[] {
    const all = [...records];
    const also = [...alsoUsed];
    if ([...all, ...also].some(record => record.configuration === null)) {
      return [];
    }
    // The indexes of the needed entries in the `allow` of their source, by the name of the source. Each configuration
    // has its own list, and a record of an older build keeps the list of an older version of the config: the place
    // of an entry in its source is what they share.
    const needed = new Map<string, Set<number>>();
    // An inherited entry of a config file is an entry of that file too: the file may be the config of other modules.
    const need = (entry: AllowEntry | undefined): void => {
      if (entry !== undefined && (entry.origin === 'own' || 'file' in entry.source)) {
        const name = this.sourceName(entry.source);
        needed.set(name, (needed.get(name) ?? new Set()).add(entry.source.index));
      }
    };
    const configurations = new Set<Configuration>();
    for (const { configuration, used } of all) {
      if (configuration) {
        configurations.add(configuration);
        used.forEach(index => need(configuration.entries[index]));
      }
    }
    for (const { configuration, used } of also) {
      used.forEach(index => need(configuration?.entries[index]));
    }
    for (const configuration of configurations) {
      configuration.issues.forEach(issue => need(configuration.entries[issue.index]));
    }
    // The versions of each source in the configurations of the records, by its name: the entries as `index:feature`.
    // One version gives one meaning to each index of the source.
    const versions = new Map<string, Set<string>>();
    for (const configuration of new Set([...all, ...also].map(record => record.configuration as Configuration))) {
      const lists = new Map<string, Set<string>>();
      for (const { source, feature } of configuration.entries) {
        const name = this.sourceName(source);
        lists.set(name, (lists.get(name) ?? new Set()).add(`${source.index}:${feature}`));
      }
      for (const [name, list] of lists) {
        versions.set(name, (versions.get(name) ?? new Set()).add([...list].join('\n')));
      }
    }
    // The features of the unused entries by their index, by the name of the source.
    const unused = new Map<string, { inFile: boolean; features: Map<number, string> }>();
    for (const configuration of configurations) {
      for (const { origin, source, feature } of configuration.entries) {
        const name = this.sourceName(source);
        if (origin !== 'own' || needed.get(name)?.has(source.index) || (versions.get(name)?.size ?? 0) > 1) {
          continue;
        }
        const group = unused.get(name) ?? { inFile: 'file' in source, features: new Map<number, string>() };
        group.features.set(source.index, feature);
        unused.set(name, group);
      }
    }
    return [...unused].map(([name, { inFile, features }]) => {
      const list = [...features]
        .sort(([a], [b]) => a - b)
        .map(([index, feature]) => `${inFile ? 'allow' : name}[${index}] "${feature}"`);
      return (
        `[compatgate] ${inFile ? `${name}: ` : ''}allow entries that suppressed no finding in the code of this build: ` +
        `${list.join(', ')}. Remove them unless other code needs them`
      );
    });
  }

  /**
   * The name of the source of own entries in messages: the path of the config, or the option, such as
   * `compatgate.allow`, as the advice of a finding and the messages of the core name it.
   */
  private sourceName(source: AllowSource): string {
    return 'file' in source ? this.displayPath(source.file) : `${source.options}.allow`;
  }

  /** The path in messages, as the messages of the core name it: relative to the project root inside it. */
  displayPath(path: string): string {
    return this.currentResolver().displayPath(path);
  }

  /** The resolver of the current `baseDir`: a host sets `baseDir` when the bundler gives its root. */
  private currentResolver(): Resolver {
    const { baseDir } = this;
    if (this.resolver.baseDir !== baseDir) {
      this.resolver = { baseDir, resolver: createResolver({ ...this.shared, baseDir, where: WHERE }) };
    }
    return this.resolver.resolver;
  }

  private matches(path: string): boolean {
    if (this.filter?.baseDir !== this.baseDir) {
      this.filter = { baseDir: this.baseDir, test: createFilter(this.options, this.baseDir) };
    }
    return this.filter.test(path);
  }
}
