import { extname } from 'node:path';

import type { Configuration, Finding } from '@compatgate/core';
import { traceSegment } from '@jridgewell/trace-mapping';

import { checkFile, usedEntries } from './checkers.ts';
import { LoweringEngineError, type Lower, type LoweredCode } from './lowering.ts';
import type { ModuleFile } from './module-id.ts';
import { copiedColumns, textLines, traceMap, type Locate } from './source-map.ts';
import type { ModuleRecord } from './records.ts';
import type { ModuleContext, PluginState } from './state.ts';
import { formatPlace, label, placeOf, type PartialFinding } from './summary.ts';

/**
 * What happens to a partial finding of the level `warn`. `show`: the module reports it. `record`: the module
 * reports it, and the record of the module keeps it for the summary at the end of the build. `hold`: only the
 * record keeps it, and the end of the build reports it.
 */
export type PartialMode = 'show' | 'record' | 'hold';

export interface CheckModuleOptions {
  /** The way from the checked code to the source. Without it the positions are in the checked code. */
  locate?: Locate | undefined;
  /** The lowering of the bundler, for the bundlers that lower the syntax after the transforms. */
  lower?: Lower | undefined;
  /**
   * The build reports unused entries. An entry that suppressed syntax then starts the lowering too: the entry may
   * be needed by none of the code in the bundle. Without the report only the findings need the lowering.
   */
  reportsUnused?: boolean | undefined;
  /** What happens to a partial finding of the level `warn`. Default: `show`. */
  partial?: PartialMode | undefined;
}

/** Checks one module and reports its findings. The code stays as it is. Gives the record of the module. */
export async function checkModule(
  state: PluginState,
  code: string,
  file: ModuleFile,
  reporter: ModuleContext,
  { locate, lower, reportsUnused = false, partial = 'show' }: CheckModuleOptions = {},
): Promise<ModuleRecord> {
  const configuration = state.configuration(file.path, reporter);
  if (!configuration) {
    return { configuration: null, used: [], partials: [] };
  }
  const result = checkFile(configuration, code, file);
  if (result.parseError) {
    reporter.warn(`[compatgate] cannot check ${state.displayPath(file.path)}: ${result.parseError.message}`);
    return { configuration, used: [], partials: [] };
  }
  let findings = result.findings.filter(finding => state.severity[finding.confidence] !== 'off');
  let used = usedEntries(result);
  const syntax =
    findings.some(finding => finding.kind === 'syntax') ||
    (reportsUnused && result.suppressed.some(item => item.kind === 'syntax'));
  if (lower && syntax) {
    const lowered = await checkLowered(configuration, code, file, findings, lower, error => {
      const message = `[compatgate] ${error.message}`;
      // The dev server has one build, so it warns of a missing engine once.
      state.once('build', message, () => reporter.warn(message));
    });
    if (lowered) {
      findings = lowered.findings;
      // An entry is used when the plugin would report a finding without it, and the findings follow one rule: those
      // of syntax come from the lowered code, the others from the checked code. So the lowered code decides only
      // about syntax. The intersection with `used` keeps out an entry that only a helper of the lowering needs.
      const loweredSyntax = new Set(lowered.syntaxUsed);
      const needed = new Set(
        result.suppressed
          .filter(item => item.kind !== 'syntax' || loweredSyntax.has(item.index))
          .map(item => item.index),
      );
      used = used.filter(index => needed.has(index));
    }
  }
  const partials: PartialFinding[] = [];
  if (findings.length === 0) {
    return { configuration, used, partials };
  }
  for (const finding of findings) {
    const source = locate?.(finding.start, { code, range: finding.range }) ?? undefined;
    const place = placeOf(state.displayPath(source?.path ?? file.path), finding, source);
    const description = finding.message;
    const message = `${label(finding.confidence)} ${formatPlace(place)}: ${description}`;
    const level = state.severity[finding.confidence] as 'error' | 'warn';
    if (partial !== 'show' && level === 'warn' && finding.confidence === 'partial') {
      partials.push({ description, feature: finding.feature, place, message });
      if (partial === 'hold') {
        continue;
      }
    }
    reporter[level](message);
  }
  return { configuration, used, partials };
}

/**
 * Checks the code that the bundler makes of the module and keeps the syntax findings that are still there. It
 * only removes findings: a helper of the lowering adds none. `null` when the bundler lowers nothing, or when
 * the lowering fails; the findings stay then.
 */
async function checkLowered(
  configuration: Configuration,
  code: string,
  file: ModuleFile,
  findings: readonly Finding[],
  lower: Lower,
  missingEngine: (error: LoweringEngineError) => void,
): Promise<{ findings: Finding[]; syntaxUsed: number[] } | null> {
  let lowered: LoweredCode | null;
  try {
    lowered = await lower(code, file);
  } catch (error) {
    // A lowering that fails on one module keeps its findings without a word: the bundler reports its own error.
    if (error instanceof LoweringEngineError) {
      missingEngine(error);
    }
    return null;
  }
  if (lowered === null) {
    return null;
  }
  // The lowered code is JavaScript, with JSX when the bundler keeps it.
  const extension = /x$/i.test(extname(file.parseAs ?? file.path)) ? '.jsx' : '.js';
  const result = checkFile(configuration, lowered.code, { path: file.path, parseAs: `${file.path}${extension}` });
  if (result.parseError) {
    return null;
  }
  const after = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    if (finding.kind === 'syntax') {
      after.set(finding.feature, [...(after.get(finding.feature) ?? []), finding]);
    }
  }
  const kept = new Map<string, (finding: Finding) => boolean>();
  const map = lowered.map;
  return {
    findings: findings.filter(finding => {
      if (finding.kind !== 'syntax') {
        return true;
      }
      let keeps = kept.get(finding.feature);
      if (!keeps) {
        const same = findings.filter(other => other.kind === 'syntax' && other.feature === finding.feature);
        keeps = survivors(same, after.get(finding.feature) ?? [], { checked: code, lowered: lowered.code, map });
        kept.set(finding.feature, keeps);
      }
      return keeps(finding);
    }),
    syntaxUsed: result.suppressed.filter(item => item.kind === 'syntax').map(item => item.index),
  };
}

/**
 * Tells which findings of one feature are still in the lowered code. When the lowering keeps some of them, the
 * map of the lowering tells which ones; without a sure answer all of them stay.
 */
function survivors(
  before: readonly Finding[],
  after: readonly Finding[],
  { checked, lowered, map }: { checked: string; lowered: string; map: unknown },
): (finding: Finding) => boolean {
  if (after.length === 0) {
    return () => false;
  }
  if (after.length >= before.length) {
    return () => true;
  }
  const traced = traceMap(() => map);
  if (!traced) {
    return () => true;
  }
  // A finding can lie inside a segment of the map, so the place of a finding of the lowered code in the checked
  // code is sure only when the segment copies the text through its token. The answer is sure only when each
  // finding of the lowered code has its own place, and each place is a finding of the checked code: a finding
  // that the lowering removed may stay, a finding that it kept never goes.
  const lines = textLines(checked);
  const copied = copiedColumns();
  const starts = new Set<string>();
  for (const finding of after) {
    const segment = traceSegment(traced, finding.start.line - 1, finding.start.column);
    // A map of the lowering has one source, the checked code.
    if (!segment || segment.length < 4 || segment[1] !== 0) {
      return () => true;
    }
    // A segment of four or five numbers has an original position: the generated column, the source, the line, the
    // column.
    const [generated, , line, original] = segment as readonly [number, number, number, number];
    const at = { line: finding.start.line - 1, generated, original };
    const column = copied(at, finding.start.column, { code: lowered, range: finding.range }, lines[line]);
    if (column === null) {
      return () => true;
    }
    starts.add(`${line + 1}:${column}`);
  }
  const matched = before.filter(finding => starts.has(`${finding.start.line}:${finding.start.column}`));
  const perPlace = new Map<string, number>();
  for (const finding of matched) {
    const place = `${finding.start.line}:${finding.start.column}`;
    perPlace.set(place, (perPlace.get(place) ?? 0) + 1);
  }
  const oneEach = [...starts].every(place => perPlace.get(place) === 1);
  if (starts.size !== after.length || !oneEach) {
    return () => true;
  }
  return finding => matched.includes(finding);
}
