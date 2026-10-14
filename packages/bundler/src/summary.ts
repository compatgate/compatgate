import type { Finding, FindingConfidence, Position } from '@compatgate/core';

/** The place of a finding, as the message gives it: `src/a.ts:3:5`. */
export interface Place {
  path: string;
  line: number;
  column: number;
  /** Whether the position is in the source file, not in the checked code. */
  mapped: boolean;
}

/** A partial finding of the level `warn`, kept for the summary at the end of the build. */
export interface PartialFinding {
  /** The text of the core. The findings with one text make one summary: one feature with one advice. */
  description: string;
  feature: string;
  place: Place;
  /** The message of the finding alone. */
  message: string;
}

/** The places that a summary names. */
const SUMMARY_PLACES = 5;

// The level of trust in a finding opens its message: the user sees which key of `severity` to change. The rules of
// the linter have the same names.
export function label(confidence: FindingConfidence): string {
  return `[compatgate/${confidence}]`;
}

/**
 * The place of a finding. Without a position in the source the message shows the position in the checked code
 * and says so: the code after the loaders or the plugins, not the source file.
 */
export function formatPlace({ path, line, column, mapped }: Place): string {
  return `${path}:${line}:${column}${mapped ? '' : ' (position in the transpiled module)'}`;
}

export function placeOf(path: string, finding: Finding, source: Position | undefined): Place {
  const { line, column } = source ?? finding.start;
  return { path, line, column: column + 1, mapped: source !== undefined };
}

/** The messages that the partial findings of a build make. */
export interface PartialSummary {
  /** A message per finding of a text in one place, and a summary per text in two or more places. */
  messages: Array<{ text: string; summary: boolean }>;
  /** The messages of the findings that the summaries give. */
  replaced: Set<string>;
}

/** Groups the partial findings by their text: one summary per text in two or more places. */
export function summarizePartials(partials: readonly PartialFinding[]): PartialSummary {
  const groups = new Map<string, PartialFinding[]>();
  for (const finding of partials) {
    const group = groups.get(finding.description);
    if (group) {
      group.push(finding);
    } else {
      groups.set(finding.description, [finding]);
    }
  }
  const messages: PartialSummary['messages'] = [];
  const replaced = new Set<string>();
  for (const [description, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [first] = group;
    if (group.length === 1 && first) {
      messages.push({ text: first.message, summary: false });
      continue;
    }
    // In the order of the paths and the lines: a build checks the modules in no fixed order.
    const places = group.map(item => item.place).sort(comparePlaces);
    const shown = places.slice(0, SUMMARY_PLACES).map(formatPlace).join(', ');
    const count = places.length > SUMMARY_PLACES ? `, the first ${SUMMARY_PLACES}` : '';
    const text = `${label('partial')} ${first?.feature} in ${group.length} places${count}: ${shown}. ${description}`;
    messages.push({ text, summary: true });
    for (const item of group) {
      replaced.add(item.message);
    }
  }
  return { messages, replaced };
}

function comparePlaces(a: Place, b: Place): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  return a.line - b.line || a.column - b.column;
}
