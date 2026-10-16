import { basename, resolve } from 'node:path';

import {
  ConfigError,
  createResolver,
  isCheckable,
  type Configuration,
  type Finding,
  type FindingConfidence,
  type Position,
} from '@compatgate/core';

import { WHERE, readSettings, type CompatgateSettings } from './settings.ts';

/** The calls into the core. Tests replace them to count the calls. */
export const core = { createResolver };

/** The part of the rule context of ESLint and oxlint that the rules use. */
export interface RuleContext {
  readonly filename: string;
  readonly physicalFilename: string;
  readonly cwd: string;
  readonly settings: { readonly [name: string]: unknown };
  /** The rules read `text`. ESLint types the source of any language, and a binary source has no text. */
  readonly sourceCode: object;
  report(descriptor: { loc: Position | { start: Position; end: Position }; message: string }): void;
}

export interface RuleModule {
  meta: {
    type: 'problem';
    /** `url`: the section of the rule in the README, which an IDE links next to the message. */
    docs: { description: string; url: string };
    /** No options: the rules share `settings.compatgate`. */
    schema: [];
  };
  /** Reports all findings at once and returns no visitor. */
  create(context: RuleContext): Record<string, never>;
}

// The rule reads only the text: the core parses it with its own parser. With no visitor oxlint does not build
// the AST in JavaScript, and a lint of 2 000 files takes 214 ms instead of 566 ms (README, "Performance").
// `createOnce` with a `before` hook is as fast, but ESLint needs `create` anyway.
// The README in the repository, as eslint-plugin-compat links its rules. GitHub makes the anchor `#exact` of the
// heading `` ### `exact` ``.
const DOCS = 'https://github.com/compatgate/compatgate/tree/main/packages/eslint';

function createRule(confidence: FindingConfidence, description: string): RuleModule {
  return {
    meta: { type: 'problem', docs: { description, url: `${DOCS}#${confidence}` }, schema: [] },
    create(context) {
      report(context, confidence);
      return {};
    },
  };
}

export const exact = createRule(
  'exact',
  'Disallow features that the browserslist targets do not support. The feature is known for sure.',
);
export const heuristic = createRule(
  'heuristic',
  'Disallow methods that the browserslist targets may not support. The method is found by its name only.',
);
export const partial = createRule(
  'partial',
  'Disallow features that the browserslist targets support only in part, with the limits of the BCD notes.',
);

// The errors of the configs have no place in the file: they go to its start, as ESLint and oxlint place a message
// of the whole file.
const FILE_START: Position = { line: 1, column: 0 };

function report(context: RuleContext, confidence: FindingConfidence): void {
  const settings = readSettings(context.settings.compatgate);
  const { text } = context.sourceCode as { text?: unknown };
  if (typeof text !== 'string') {
    return;
  }
  const result = findings(context, settings, confidence, text);
  // One rule reports them: three rules would give three equal messages.
  if (confidence === 'exact') {
    for (const message of result.configErrors) {
      context.report({ loc: FILE_START, message });
    }
  }
  for (const finding of result.findings) {
    if (finding.confidence === confidence && (settings.syntax === true || finding.kind !== 'syntax')) {
      context.report({ loc: { start: finding.start, end: finding.end }, message: finding.message });
    }
  }
}

interface Result {
  findings: readonly Finding[];
  /** The messages of the errors of the configs: the exact rule reports them at the start of the file. */
  configErrors: readonly string[];
}

const NOTHING: Result = { findings: [], configErrors: [] };

interface LastResult extends Result {
  key: string;
  /** The rules that took the result. A rule that asks again lints the file again. */
  served: Set<FindingConfidence>;
}

// The three rules of one file share one call of the core. The key holds the names, the settings and the text:
// oxlint may keep one source object for all files, and two files with one text differ in their `allow.files`.
// A rule that has taken the result already starts a new lint of the file: an IDE lints the same text again
// after an edit of compatgate.jsonc, and the edit must show.
let last: LastResult | undefined;

function findings(
  context: RuleContext,
  settings: CompatgateSettings,
  confidence: FindingConfidence,
  text: string,
): Result {
  // The JSON array ends where it starts, so the text after it cannot make two keys equal.
  const key = JSON.stringify([context.filename, context.physicalFilename, context.cwd, settings]) + text;
  if (last?.key === key && !last.served.has(confidence)) {
    last.served.add(confidence);
    return last;
  }
  last = undefined;
  const result = run(context, settings, text);
  last = { ...result, key, served: new Set([confidence]) };
  return result;
}

function run(context: RuleContext, settings: CompatgateSettings, text: string): Result {
  const { cwd } = context;
  // A setting of a wrong type fails the rule, as ESLint fails a rule with wrong options. The cwd of the linter is the
  // project root: a project that lies inside node_modules keeps its own configs.
  const resolver = core.createResolver({
    targets: settings.targets,
    defaultTargets: settings.defaultTargets,
    allow: settings.allow,
    extends: settings.extends,
    baseDir: cwd,
    where: WHERE,
  });
  const parseAs = parserFilename(context.filename, cwd);
  // A file of another language, such as a whole `.vue` component.
  if (!isCheckable(parseAs)) {
    return NOTHING;
  }
  // A processor block (`README.md/0.js`) has no file of its own: the configs are found from the physical file,
  // and the `files` of `allow` match it. The name of the block selects the parser only.
  const configFile = resolve(cwd, context.physicalFilename);
  let configuration: Configuration;
  try {
    configuration = resolver.resolve(configFile);
  } catch (error) {
    // An error of the configs, the settings `targets` and `allow` included, is a message in each file, so that an
    // IDE shows it and the other rules and files are checked.
    if (error instanceof ConfigError) {
      return { ...NOTHING, configErrors: [error.message] };
    }
    throw error;
  }
  const configErrors = unknownFeatures(configuration);
  const result = configuration.checker.check(text, configFile, parseAs === configFile ? undefined : parseAs);
  // The parser of the linter reports a syntax error itself.
  if (result.parseError || result.findings.length === 0) {
    return configErrors.length === 0 ? NOTHING : { ...NOTHING, configErrors };
  }
  return { findings: result.findings, configErrors };
}

/**
 * The name that selects the parser of the core. A relative name resolves against the cwd of the linter.
 * Text without a file (`<input>`, `<text>`) is JavaScript.
 */
function parserFilename(filename: string, cwd: string): string {
  const absolute = resolve(cwd, filename);
  return /^<[^>]*>$/.test(basename(absolute)) ? `${absolute}.js` : absolute;
}

// An entry that became native is no error: the linter has no place for a warning about a config, and a message
// in every file is noise. The bundler reports it. An unknown id of the project is a typo that would hide
// nothing, so it is an error in each file. An unknown id of a base is a warning of the process: a list shared by
// many projects may name a feature of a newer core, and it is not the project to fix.
const warned = new Set<string>();

/** Gives the messages of the unknown ids of the project and warns of the unknown ids of a base. */
function unknownFeatures(configuration: Configuration): string[] {
  const messages: string[] = [];
  const { entries } = configuration;
  for (const issue of configuration.issues) {
    const entry = entries[issue.index];
    if (issue.kind !== 'unknown-feature' || entry === undefined) {
      continue;
    }
    if (entry.origin === 'own') {
      messages.push(issue.message);
      continue;
    }
    // The absolute path of the source tells two projects of one process apart.
    const key = JSON.stringify([entry.source, entry.feature]);
    if (!warned.has(key)) {
      warned.add(key);
      process.emitWarning(`compatgate: ${issue.message}`, { code: 'COMPATGATE_ALLOW' });
    }
  }
  return messages;
}
