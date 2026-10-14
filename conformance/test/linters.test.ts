// The linters run the corpus of the core and must give its findings line by line: feature, confidence and column.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createResolver, type FindingConfidence } from '@compatgate/core';
import plugin from '@compatgate/eslint';
import typescriptParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';

import {
  countCases,
  differences,
  placedAllow,
  placedPath,
  positionOfByte,
  readCorpus,
  type CorpusFile,
  type ToolFinding,
} from '../src/corpus.ts';

const require = createRequire(import.meta.url);
const oxlintBin = fileURLToPath(new URL('../node_modules/.bin/oxlint', import.meta.url));
const pluginEntry = require.resolve('@compatgate/eslint');
const CONFIDENCES: readonly FindingConfidence[] = ['exact', 'heuristic', 'partial'];

/**
 * JavaScript files that espree, the default parser of ESLint, does not parse, with the reason. ESLint parses them
 * with the parser of typescript-eslint, which parses JavaScript too. The rules read only the text of the file.
 */
const TYPESCRIPT_PARSER: ReadonlyMap<string, string> = new Map([
  ['guards/try.js', 'espree does not parse auto-accessors (`accessor f = …`)'],
  ['methods/declared/accessor.js', 'espree does not parse auto-accessors (`accessor take`)'],
  ['methods/declared/accessor-string.js', "espree does not parse auto-accessors (`accessor 'take'`)"],
]);

const files = readCorpus();
let root: string;

before(() => {
  // The linters read files from the disk: each file lies at its `// filename:` inside a temporary directory.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compatgate-conformance-')));
  const placed = new Map<string, string>();
  for (const file of files) {
    const path = placedPath(root, file);
    const other = placed.get(path);
    assert.equal(other, undefined, `${file.name} and ${other} have one filename`);
    placed.set(path, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.source);
  }
});

after(() => rmSync(root, { recursive: true, force: true }));

/** The settings of the rules for a file: its targets and allow entries, and syntax, which the core reports too. */
function settings(file: CorpusFile) {
  return { targets: file.targets, allow: placedAllow(root, file), syntax: true };
}

/** Runs a tool over the corpus and fails with every line where its findings differ from the expectations. */
function compare(tool: string, findings: (file: CorpusFile) => ToolFinding[]): void {
  const report = files.flatMap(file => differences(file, findings(file)));
  assert.ok(
    report.length === 0,
    `the findings of ${tool} differ from the expectations (- expected, + found):\n\n${report.join('\n\n')}\n`,
  );
}

test('the corpus has expectations', () => {
  assert.ok(files.length > 0);
  assert.ok(countCases(files) > 0);
});

// The suite reads the corpus as `tests/corpus.rs` does: the core through the binding gives the expectations.
test('the core gives the findings of the corpus', () => {
  compare('the core', file => {
    const filename = placedPath(root, file);
    const resolver = createResolver({ targets: file.targets, allow: placedAllow(root, file) });
    const result = resolver.check(file.source, filename);
    assert.equal(result.parseError, undefined, file.name);
    return result.findings.map(finding => ({
      line: finding.start.line,
      column: finding.start.column + 1,
      feature: finding.feature,
      confidence: finding.confidence,
    }));
  });
});

test('ESLint gives the findings of the core', t => {
  const linter = new Linter({ cwd: root });
  compare('ESLint', file => {
    const filename = placedPath(root, file);
    const extension = extname(filename);
    const typescript = ['.ts', '.tsx', '.mts', '.cts'].includes(extension);
    const parser = typescript || TYPESCRIPT_PARSER.has(file.name) ? { parser: typescriptParser } : {};
    const messages = linter.verify(
      file.source,
      [
        // ESLint ignores `node_modules` by default; the corpus has files of packages.
        { ignores: ['!**/node_modules/'] },
        {
          files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
          plugins: { compatgate: plugin },
          rules: { 'compatgate/exact': 'error', 'compatgate/heuristic': 'error', 'compatgate/partial': 'error' },
          languageOptions: {
            sourceType: file.sourceType,
            ...parser,
            // `check` parses JSX in plain JavaScript files too; TypeScript has JSX in `.tsx` only.
            parserOptions: { ecmaFeatures: { jsx: !typescript || extension === '.tsx' } },
          },
          settings: { compatgate: settings(file) },
        },
      ],
      filename,
    );
    return messages.map(message => {
      assert.ok(message.ruleId, `${file.name}:${message.line}: ${message.message}`);
      const confidence = message.ruleId.replace(/^compatgate\//, '') as FindingConfidence;
      assert.ok(CONFIDENCES.includes(confidence), `${file.name}: a message of ${message.ruleId}`);
      return { line: message.line, column: message.column, feature: featureOf(message.message), confidence };
    });
  });
  for (const [name, reason] of TYPESCRIPT_PARSER) {
    t.diagnostic(`${name}: the parser of typescript-eslint, ${reason}`);
  }
});

interface OxlintDiagnostic {
  message: string;
  code: string;
  filename: string;
  labels: Array<{ span: { offset: number; length: number } }>;
}

test('oxlint gives the findings of the core', () => {
  // oxlint takes one config per run: the files with the same targets and allow entries run together.
  const groups = new Map<string, CorpusFile[]>();
  for (const file of files) {
    const key = JSON.stringify(settings(file));
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }
  const found = new Map<string, ToolFinding[]>();
  for (const [index, [key, group]] of [...groups].entries()) {
    const config = join(root, `oxlintrc-${index}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [],
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'compatgate', specifier: pluginEntry }],
        rules: { 'compatgate/exact': 'error', 'compatgate/heuristic': 'error', 'compatgate/partial': 'error' },
        settings: { compatgate: JSON.parse(key) },
      }),
    );
    const paths = group.map(file => placedPath(root, file));
    const run = spawnSync(oxlintBin, ['-c', config, '--format', 'json', ...paths], { cwd: root, encoding: 'utf8' });
    assert.ok(run.stdout.startsWith('{'), `oxlint failed: ${run.stdout}\n${run.stderr}`);
    const output: { diagnostics: OxlintDiagnostic[]; number_of_files: number } = JSON.parse(run.stdout);
    // oxlint ignores some paths, such as `node_modules`, unless they are given: a file left out has no findings.
    assert.equal(
      output.number_of_files,
      group.length,
      `oxlint linted ${output.number_of_files} of ${paths.join(', ')}`,
    );
    const { diagnostics } = output;
    for (const file of group) {
      found.set(file.name, []);
    }
    for (const diagnostic of diagnostics) {
      const file = group.find(item => placedPath(root, item) === join(root, diagnostic.filename));
      assert.ok(file, `oxlint reported a file out of the run: ${diagnostic.filename}: ${diagnostic.message}`);
      // A crash of a rule and a parse error are diagnostics too, of another code.
      const confidence = /^compatgate\((\w+)\)$/.exec(diagnostic.code)?.[1] as FindingConfidence | undefined;
      assert.ok(
        confidence && CONFIDENCES.includes(confidence),
        `${file.name}: ${diagnostic.code}: ${diagnostic.message}`,
      );
      // The JSON output of oxlint counts columns in bytes; the corpus counts UTF-16 code units.
      const { line, column } = positionOfByte(
        file.source,
        (diagnostic.labels[0] as OxlintDiagnostic['labels'][0]).span.offset,
      );
      found.get(file.name)?.push({ line, column, feature: featureOf(diagnostic.message), confidence });
    }
  }
  compare('oxlint', file => found.get(file.name) ?? assert.fail(`oxlint did not lint ${file.name}`));
});

/** The message of a finding starts with its feature: see `Finding.message` of the core. */
function featureOf(message: string): string {
  return message.split(' ')[0] as string;
}
