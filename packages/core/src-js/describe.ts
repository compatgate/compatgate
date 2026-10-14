import { ALLOW_FILE, type AllowEntry } from './allow.ts';
import { displayPaths } from './paths.ts';
import type { CoreAllowIssue, CoreFinding, Gap } from './types.ts';

// The names of the BCD browsers that the core knows, from `browsers.*.name` of BCD. An id that is missing
// here, such as a browser that a newer core adds, stays as it is in the message.
const BROWSER_NAMES: Readonly<Record<string, string>> = {
  chrome: 'Chrome',
  chrome_android: 'Chrome Android',
  edge: 'Edge',
  firefox: 'Firefox',
  firefox_android: 'Firefox for Android',
  opera: 'Opera',
  opera_android: 'Opera Android',
  safari: 'Safari',
  safari_ios: 'Safari on iOS',
  samsunginternet_android: 'Samsung Browser',
  webview_android: 'WebView Android',
};

export interface DescribeFindingOptions {
  /**
   * The place of the `allow` entries of the project, which the advice names: the path of its compatgate.jsonc or an
   * option, such as `settings.compatgate.allow`. Default: `compatgate.jsonc`.
   */
  allowIn?: string;
  /** The project root: a path of `allowIn` inside it is named relative to the root. */
  baseDir?: string;
}

/**
 * Gives the message of a finding, the same in the linter and in the bundler: the feature, the targets
 * without support and the first version with support, the BCD notes on partial support, the alternatives
 * of a heuristic finding and how to resolve it.
 */
export function describeFinding(finding: CoreFinding, options: DescribeFindingOptions = {}): string {
  // Only partial support has notes: a heuristic finding with notes is partial too.
  const partial = finding.confidence === 'partial' || finding.unsupported.some(gap => gap.note !== undefined);
  const gaps = finding.unsupported.map(gap => `${target(gap)} (${support(gap, partial)})`).join(', ');
  const sentences = [
    `${finding.feature} is ${partial ? 'only partially supported' : 'not supported'} in ${gaps}.`,
    ...notes(finding.unsupported),
  ];
  if (finding.confidence === 'heuristic') {
    sentences.push(
      finding.alternatives.length > 0
        ? `The method is found by its name, so it may also be ${finding.alternatives.join(', ')}.`
        : 'The method is found by its name: the type of the object is unknown.',
    );
  }
  const { allowIn = ALLOW_FILE } = options;
  sentences.push(advice(finding, partial, displayPaths(allowIn, options.baseDir)));
  return sentences.join(' ');
}

function target(gap: Gap): string {
  return `${BROWSER_NAMES[gap.browser] ?? gap.browser} ${gap.target}`;
}

function support(gap: Gap, partial: boolean): string {
  if (partial) {
    return gap.since ? `full support since ${gap.since}` : 'no full support in any version';
  }
  return gap.since ? `since ${gap.since}` : 'no support in any version';
}

// Browsers of one engine often share a note, such as Safari and Safari on iOS: the note is given once.
function notes(gaps: readonly Gap[]): string[] {
  const targets = new Map<string, string[]>();
  for (const gap of gaps) {
    if (gap.note !== undefined) {
      targets.set(gap.note, [...(targets.get(gap.note) ?? []), target(gap)]);
    }
  }
  return [...targets].map(([note, names]) => `${names.join(', ')}: ${/[.!?]$/.test(note) ? note : `${note}.`}`);
}

// A check in code cannot protect syntax: a file with it does not parse in an older browser. A check
// cannot detect partial support either: the code works there, but with the limits of the notes.
function advice(finding: CoreFinding, partial: boolean, allowIn: string): string {
  const entry = `add "${finding.feature}" to ${allowIn}`;
  if (partial) {
    return `If the limits do not affect this code, ${entry}.`;
  }
  if (finding.kind === 'syntax') {
    return `Lower the syntax with the transpiler, or ${entry}.`;
  }
  return `Check the feature in code, or ${entry}.`;
}

export interface DescribeAllowIssueOptions {
  /** The project root: a config file inside it is named by its path relative to the root. */
  baseDir?: string;
}

/**
 * Gives the message of a problem of an `allow` entry, the same in the linter and in the bundler. The message names
 * the place of the entry: `compatgate.jsonc, allow[3]` or `settings.compatgate.allow[3]`, and the closest known id
 * for an unknown one. An inherited entry gets no fix: a base list shared by many projects may name a feature of
 * a newer compatgate, and the project may not own the base.
 */
export function describeAllowIssue(
  issue: CoreAllowIssue,
  entry: AllowEntry,
  options: DescribeAllowIssueOptions = {},
): string {
  const { source } = entry;
  const place =
    'file' in source
      ? `${displayPaths(source.file, options.baseDir)}, allow[${source.index}]`
      : `${source.options}.allow[${source.index}]`;
  if (issue.kind === 'native-in-targets') {
    const advice = entry.origin === 'inherited' ? 'The entry has no effect.' : 'Remove the entry.';
    return `${place}: every target browser supports "${entry.feature}". ${advice}`;
  }
  const advice =
    entry.origin === 'inherited'
      ? 'compatgate ignores the entry.'
      : 'A feature id is a path in @mdn/browser-compat-data, such as "api.structuredClone".';
  const hint = issue.suggestion === undefined ? '' : ` Did you mean "${issue.suggestion}"?`;
  return `${place}: unknown feature "${entry.feature}". ${advice}${hint}`;
}
