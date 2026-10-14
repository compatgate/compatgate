// The public types of the results. They are written by hand, so that the generated types of the binding
// stay internal; `test/types.test.ts` fails the type check when the two drift apart.

/** The `code` of an error that compatgate throws. A source that does not parse is no error: see `CheckResult.parseError`. */
export type ErrorCode = 'COMPATGATE_TARGETS' | 'COMPATGATE_ALLOW' | 'COMPATGATE_OPTIONS' | 'COMPATGATE_INTERNAL';

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
  /**
   * The message of the finding, the same in the linter and in the bundler: the feature, the targets without support
   * and the first version with support, the BCD notes on partial support, the alternatives of a heuristic finding
   * and how to resolve it. The advice names the place of the `allow` entries of the project.
   */
  message: string;
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

/** An `allow` entry that suppressed findings of one kind. */
export interface Suppression {
  /** Index of the entry in the `allow` list of the checker. */
  index: number;
  kind: FindingKind;
}

export interface CheckResult {
  findings: Finding[];
  /**
   * For each `allow` entry that silenced a finding, the kind of that finding: one item per entry and kind, ordered
   * by the index, then by the kind (`syntax`, `builtin`, `api`). The unique indexes are the entries that the file
   * uses. A bundler that lowers the syntax after the check may need no entry that suppressed syntax only.
   */
  suppressed: Suppression[];
  /** Set when the source does not parse. `findings` is empty then. */
  parseError?: ParseError;
}

export interface Checker {
  /**
   * Checks one file. `filename` matches the `files` and `packages` of the entries and selects the parser.
   * `parseAs` is a name whose extension selects the parser instead, such as `/src/App.vue.ts` for the script
   * of `/src/App.vue`.
   */
  check(source: string, filename: string, parseAs?: string | undefined | null): CheckResult;
}

export type AllowIssueKind = 'unknown-feature' | 'native-in-targets';

export interface AllowIssue {
  /** Index of the entry in the list of the checker. */
  index: number;
  kind: AllowIssueKind;
  /**
   * The closest known id for an unknown one: the id with `_static`, or a sibling a few edits away, such as
   * `api.fetch` for `api.fetchh`. A mistyped parent segment is corrected the same way. A segment below six
   * characters allows one edit, a longer one two. Absent when there is none.
   */
  suggestion?: string;
  /**
   * The message of the problem, the same in the linter and in the bundler. It names the place of the entry:
   * `compatgate.jsonc, allow[3]` or `settings.compatgate.allow[3]`, and the closest known id for an unknown one.
   */
  message: string;
}

// The results of the binding: the core adds the messages.

/** @internal */
export type CoreFinding = Omit<Finding, 'message'>;

/** @internal */
export interface CoreCheckResult extends Omit<CheckResult, 'findings'> {
  findings: CoreFinding[];
}

/** @internal */
export type CoreAllowIssue = Omit<AllowIssue, 'message'>;

/** @internal — the checker of the binding. */
export interface CoreChecker {
  check(source: string, filename: string, parseAs?: string | undefined | null): CoreCheckResult;
  /** The entries with an unknown feature id and the entries that every target supports. */
  issues(): CoreAllowIssue[];
  /** browserslist names in the targets that compatgate has no data for. compatgate does not check them. */
  get ignoredBrowsers(): string[];
}
