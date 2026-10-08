// The public types of the results. They are written by hand, so that the generated types of the binding
// stay internal; `test/types.test.ts` fails the type check when the two drift apart.

/** The `code` of an error that compatgate throws. A source that does not parse is no error: see `CheckResult.parseError`. */
export type ErrorCode = 'COMPATGATE_TARGETS' | 'COMPATGATE_ALLOW' | 'COMPATGATE_INTERNAL';

export type FindingKind = 'syntax' | 'builtin' | 'api';

/**
 * `exact`: the feature is used. `heuristic`: a method found by its name on an object of unknown type.
 * `partial`: some targets support the feature only in part.
 */
export type FindingConfidence = 'exact' | 'heuristic' | 'partial';

export interface Position {
  /** Starts at 1. */
  line: number;
  /** Starts at 0. Counted in UTF-16 code units, without the byte order mark, as in ESLint. */
  column: number;
}

/** A target browser that lacks the feature. Versions are strings such as `'15.6'`. */
export interface Gap {
  browser: string;
  target: string;
  /** The first version with support. Absent when no version supports the feature. */
  since?: string;
  /** The BCD note on partial support. */
  note?: string;
}

export interface Finding {
  /** The BCD id of the feature, such as `api.structuredClone`. */
  feature: string;
  kind: FindingKind;
  confidence: FindingConfidence;
  /**
   * Other features that the same code may use. A `heuristic` finding cannot tell them apart, and an
   * `allow` entry for any of them suppresses it. Empty for other findings.
   */
  alternatives: string[];
  start: Position;
  end: Position;
  /** UTF-16 offsets into the checked source string: `source.slice(...range)` is the code of the finding. */
  range: [number, number];
  unsupported: Gap[];
}

/** `syntax`: the source has a syntax error. `unsupported-file`: the extension of the filename selects no parser. */
export type ParseErrorKind = 'syntax' | 'unsupported-file';

/** A source that compatgate cannot parse. */
export interface ParseError {
  kind: ParseErrorKind;
  /** The message of the parser, without the filename and the position. */
  message: string;
  /** Set for a syntax error only. */
  line?: number;
  /** Set for a syntax error only. */
  column?: number;
}

export interface CheckResult {
  findings: Finding[];
  /** Indexes of the `allow` entries that suppressed at least one finding. */
  usedAllow: number[];
  /** browserslist names in the targets that compatgate has no data for. */
  ignoredBrowsers: string[];
  /** Set when the source does not parse. `findings` is empty then. */
  parseError?: ParseError;
}

export interface Checker {
  /** Checks one file. `filename` selects the parser and matches the `files` and `packages` of the entries. */
  check(source: string, filename: string): CheckResult;
}

export type AllowIssueKind = 'unknown-feature' | 'native-in-targets';

export interface AllowIssue {
  /** Index of the entry in the checked list. */
  index: number;
  kind: AllowIssueKind;
}
