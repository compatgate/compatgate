import { dirname } from 'node:path';

import { checkModule } from './check.ts';
import type { BuildEnd, BuildEndContext, Host, HostReports, HookContext } from './hosts/index.ts';
import type { PluginState } from './state.ts';
import { summarizePartials } from './summary.ts';

// The part of the plugin that every bundler shares: the selection of a module, its check, the reports at the end
// of a build and its errors. Each property that differs between the bundlers comes from the host.

/** The reports of a build: the dev server of Vite has no end of a build, and so no reports. */
function reportsOf(host: Host): HostReports | undefined {
  return host.endless?.() ? undefined : host.reports;
}

/** Checks the module of a transform. */
export async function transformModule(
  state: PluginState,
  host: Host,
  context: HookContext,
  code: string,
  id: string,
): Promise<void> {
  const file = state.select(host.file(context, id));
  if (!file) {
    return;
  }
  const reports = reportsOf(host);
  const errors: string[] = [];
  const record = await checkModule(state, code, file, host.channels(context, errors), {
    locate: host.locate(context, file),
    lower: host.lower(context),
    reportsUnused: reports !== undefined,
    partial: reports?.partial(context) ?? 'show',
  });
  if (reports) {
    state.records.set(reports.key?.(context, id) ?? id, record, reports.inGraph?.(context) ?? true);
    state.partials.push(...record.partials);
  }
  if (errors.length > 0 && host.endless?.()) {
    // The dev server answers the module with the error, and the overlay shows it.
    context.error(errors.join('\n'));
  } else {
    state.errors.push(...errors);
  }
}

/** Ends a build: the reports at its end, then one error with the errors of its modules. */
export function endBuild(state: PluginState, host: Host, context: BuildEndContext | undefined, failed: boolean): void {
  const reports = reportsOf(host);
  if (context && reports) {
    reportAtEnd(state, reports, context, failed);
  }
  if (failed || state.errors.length > 0) {
    state.records.dropBuild();
  }
  if (state.errors.length === 0) {
    return;
  }
  const message = buildErrorMessage(state.errors);
  // A build that failed for another reason keeps its own error: compatgate would hide it.
  if (failed) {
    context?.warn?.(message);
    return;
  }
  // A thrown error suits every bundler: esbuild gives the end of a build no `this.error`. Without a stack:
  // Rolldown and Vite would print the stack of the plugin under the message.
  const error: Error & { watchFiles?: string[] } = new Error(message);
  error.stack = '';
  // Rollup takes the watched files of a failed build from its error, and a hook at the end of a build adds
  // none: without them the watch mode would see no edit, of the code or of a config. A missing config goes as its
  // directory: Rollup watches a missing file through a filter on its directory, and its chokidar 3 reads a directory
  // for one filter at a time, so on Linux only the first missing config of the project root would show.
  const watched = context?.getWatchFiles?.();
  if (watched) {
    const missing = state.missingFiles;
    error.watchFiles = [
      ...new Set([...watched.filter(file => !missing.has(file)), ...[...missing].map(file => dirname(file))]),
    ];
  }
  throw error;
}

/** The one error of a build that reports its errors at the end. */
function buildErrorMessage(errors: readonly string[]): string {
  const count = errors.length === 1 ? '1 error' : `${errors.length} errors`;
  return `compatgate found ${count}:\n${errors.join('\n')}`;
}

/**
 * The reports at the end of a build: the summary of the partial findings and the own entries that suppressed no
 * finding. Both need a record of the current code of every checked module of the graph. A module from a cache
 * keeps the record of the build that checked it in this process; a module from the persistent cache of a new
 * process has none, and its findings and entries are unknown. Without a complete report the partial findings show
 * one by one, and the entries are not reported.
 */
function reportAtEnd(state: PluginState, reports: HostReports, context: BuildEndContext, failed: boolean): void {
  const end = reports.end(context, failed);
  if (end === null) {
    const held = reports.partial(context) === 'hold' ? state.partials.length : 0;
    // A failed build keeps its own error: the held findings of its modules go with it.
    if (held > 0 && !failed) {
      state.records.dropBuild();
      throw new Error(
        `[compatgate] the bundler gives the end of the build no way to warn: ${held} partial findings would be ` +
          'lost. This is a bug of compatgate',
      );
    }
    return;
  }
  // The walk over the modules costs tens of milliseconds in a large build. It runs when a module of this build
  // holds a partial finding, when the records give an unused entry, or when a record is older than this build:
  // it may belong to a module that left the graph, and only the walk tells.
  const quiet =
    state.records.fresh() &&
    state.partials.length === 0 &&
    state.unusedEntries(state.records.graphRecords(), state.records.outsideRecords()).length === 0;
  if (quiet) {
    return;
  }
  const records = state.records.collect(end.modules(), file => state.select(file));
  if (records === null) {
    // The recorded findings stay with their modules, as a cache gives them again with a module.
    showHeld(state, end);
    return;
  }
  const unused = state.unusedEntries(records, state.records.outsideRecords());
  const summary = summarizePartials(records.flatMap(record => record.partials));
  // The modules that recorded their partial findings have shown them: only the summaries are new then.
  const partials = summary.messages.filter(message => end.partial === 'hold' || message.summary);
  if (end.partial === 'record') {
    end.retract(summary.replaced);
  }
  if (partials.length > 0 || unused.length > 0) {
    end.warn([...partials.map(message => message.text), ...unused]);
  }
}

function showHeld(state: PluginState, end: BuildEnd): void {
  if (end.partial === 'hold' && state.partials.length > 0) {
    end.warn(state.partials.map(finding => finding.message));
  }
}
