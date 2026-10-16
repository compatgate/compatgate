// The bundlers build the fixture project and must give the findings of `fixture/expected.json`, as the core does
// for its sources, at the same positions: the place in a message is the line and column of the source, through the
// source maps of the loaders in rspack and the combined source map of the transforms in Vite. The label of a message
// gives the confidence.
//
// The main builds lower no syntax (target `esnext`), so the modules keep the syntax of the source. One more build of
// Vite lowers for the target of `fixture/expected-lowered.json`: the findings that the lowering removes go, the
// other findings stay, syntax included.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { compatgateRspack, compatgateVite, type CompatgateBundlerOptions } from '@compatgate/bundler';
import { createResolver, type FindingConfidence } from '@compatgate/core';
import { rspack, type RspackOptions, type Stats } from '@rspack/core';
import { build as viteBuild, type Logger, type Plugin } from 'vite';

const fixture = realpathSync(fileURLToPath(new URL('../fixture', import.meta.url)));
const CONFIDENCES: readonly FindingConfidence[] = ['exact', 'heuristic', 'partial'];
/**
 * The options of the adapters: a base allow list, as a build tool passes its own. Every finding is a warning: a
 * build of Vite with errors gives them in one error at its end.
 */
const OPTIONS = {
  extends: ['./base.jsonc'],
  severity: { exact: 'warn', heuristic: 'warn', partial: 'warn' },
} satisfies CompatgateBundlerOptions;

interface Expected {
  /** The path of the module from the fixture root, with `/`. */
  module: string;
  /** The position of the start of the finding in the source: the line from 1, the UTF-16 column from 1. */
  line: number;
  column: number;
  feature: string;
  confidence: FindingConfidence;
  /** Fragments of text that the message of the finding contains. */
  messageIncludes?: string[];
}

interface Reported {
  module: string;
  line: number;
  column: number;
  feature: string;
  confidence: FindingConfidence;
  message: string;
}

/** A build of Vite that lowers the syntax for `target`; the findings of `lowered` go. */
interface ExpectedLowered {
  target: string;
  lowered: Omit<Expected, 'confidence' | 'messageIncludes'>[];
}

const expected: Expected[] = JSON.parse(readFileSync(join(fixture, 'expected.json'), 'utf8'));
const expectedLowered: ExpectedLowered = JSON.parse(readFileSync(join(fixture, 'expected-lowered.json'), 'utf8'));

type Place = Pick<Expected, 'module' | 'line' | 'column' | 'feature'>;
const place = (item: Place) => `${item.module}:${item.line}:${item.column} ${item.feature}`;

/**
 * The name of `path` in the fixture with `/` separators, or undefined for a path outside it. `relative` takes both
 * separators on Windows, where Vite gives `/`; only the separator of the system becomes `/`, as `\\` is a character of
 * a name elsewhere.
 */
function fixtureName(path: string): string | undefined {
  const name = relative(fixture, path);
  return name === '' || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)
    ? undefined
    : name.split(sep).join('/');
}

/** The JavaScript and TypeScript sources of the fixture, its packages included. */
const sources = readdirSync(fixture, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && ['.js', '.ts'].includes(extname(entry.name)))
  .flatMap(entry => fixtureName(join(entry.parentPath, entry.name)) ?? [])
  .sort();

let output: string;

before(() => {
  // `native` gives the long names of Windows: its temporary directory has a short one, such as `RUNNER~1`.
  output = realpathSync.native(mkdtempSync(join(tmpdir(), 'compatgate-conformance-')));
});

after(() => rmSync(output, { recursive: true, force: true }));

/** Fails with the findings that differ from the expected ones. Duplicates count. */
function compare(tool: string, reported: readonly Reported[], wanted: readonly Expected[] = expected): void {
  const key = (item: Place & { confidence: string }) => `${place(item)} ${item.confidence}`;
  const missing = wanted.map(key);
  const extra: string[] = [];
  for (const item of reported) {
    const index = missing.indexOf(key(item));
    if (index === -1) {
      extra.push(key(item));
    } else {
      missing.splice(index, 1);
    }
  }
  assert.ok(
    missing.length === 0 && extra.length === 0,
    `the findings of ${tool} differ from the expectations:\n` +
      [...missing.map(item => `  - ${item}`), ...extra.map(item => `  + ${item}`)].join('\n'),
  );
  for (const item of wanted) {
    const found = reported.find(other => key(other) === key(item));
    for (const fragment of item.messageIncludes ?? []) {
      assert.ok(
        found?.message.includes(fragment),
        `${tool}: the message of ${key(item)} does not include "${fragment}": ${found?.message}`,
      );
    }
  }
}

const COMPATGATE = /\[compatgate[\]/]/;
// `[compatgate/exact] src/a.js:2:7: <the message of the core>`. A place in the transpiled module has the note
// `(position in the transpiled module)` after it, and the regular expressions reject it: a build of the fixture makes
// source maps.
const FINDING = /\[compatgate\/(exact|heuristic|partial)\] (.+?):(\d+):(\d+): ((\S+) is .*)$/s;
// `[compatgate/partial] <feature> in 3 places: src/a.js:2:7, src/b.js:1:1. <the message of the core>`, with
// `, the first 5` after the count of more than five places.
const SUMMARY = /\[compatgate\/partial\] (\S+) in (\d+) places(, the first 5)?: (.+?)\. (\1 is .*)$/s;
const PLACE = /^(.+?):(\d+):(\d+)$/;

/**
 * The findings in the messages of a build: a message per finding, or a summary of the places of a partial
 * feature. Every other message of compatgate fails: the fixture uses every allow entry and has no errors of configs.
 */
function findingsOf(tool: string, messages: readonly string[]): Reported[] {
  return messages
    .map(text => stripVTControlCharacters(text))
    .filter(text => COMPATGATE.test(text))
    .flatMap(text => {
      const summary = SUMMARY.exec(text);
      if (summary) {
        const [, feature, count, more, places, message] = summary as unknown as string[];
        assert.ok(!more, `${tool}: a summary of more places than it names: ${text}`);
        const parts = (places ?? '').split(', ').map(item => PLACE.exec(item));
        assert.equal(parts.length, Number(count), `${tool}: ${text}`);
        return parts.map(part => {
          assert.ok(part, `${tool}: a place of a summary: ${text}`);
          const [, module = '', line, column] = part;
          return {
            module,
            line: Number(line),
            column: Number(column),
            feature: feature ?? '',
            confidence: 'partial' as const,
            message: message ?? '',
          };
        });
      }
      const match = FINDING.exec(text);
      assert.ok(match, `${tool}: a message of compatgate that is no finding at a place of the source: ${text}`);
      const [, confidence, module, line, column, message, feature] = match as unknown as [
        string,
        FindingConfidence,
        string,
        string,
        string,
        string,
        string,
      ];
      return [{ module, line: Number(line), column: Number(column), feature, confidence, message }];
    });
}

test('the fixture has expectations of every confidence', () => {
  for (const confidence of CONFIDENCES) {
    assert.ok(
      expected.some(item => item.confidence === confidence),
      confidence,
    );
  }
});

test('the core gives the expected findings for the sources of the fixture', () => {
  const resolver = createResolver({ extends: OPTIONS.extends, baseDir: fixture });
  const reported = sources.flatMap(name => {
    const filename = join(fixture, name);
    const result = resolver.check(readFileSync(filename, 'utf8'), filename);
    assert.equal(result.parseError, undefined, name);
    return result.findings.map(finding => ({
      module: name,
      line: finding.start.line,
      column: finding.start.column + 1,
      feature: finding.feature,
      confidence: finding.confidence,
      message: finding.message,
    }));
  });
  compare('the core', reported);
});

test('rspack gives the expected findings', async () => {
  const stats = await buildRspack();
  const json = stats.toJson({ all: false, errors: true, warnings: true });
  const messages = [...(json.errors ?? []), ...(json.warnings ?? [])].map(item => item.message);
  const built = [...stats.compilation.modules].flatMap(module =>
    'resource' in module && typeof module.resource === 'string' ? (fixtureName(module.resource) ?? []) : [],
  );
  assert.deepEqual(built.sort(), sources, 'rspack builds every source of the fixture');
  compare('rspack', findingsOf('rspack', messages));
});

test('Vite gives the expected findings', async () => {
  const { warnings, transformed } = await buildVite('esnext');
  assert.deepEqual(transformed.sort(), sources, 'Vite builds every source of the fixture');
  compare('Vite', findingsOf('Vite', warnings));
});

test('Vite that lowers the syntax gives the findings that the lowering keeps', async () => {
  const lowered = new Set(expectedLowered.lowered.map(place));
  for (const item of lowered) {
    assert.ok(
      expected.some(other => place(other) === item),
      `expected-lowered.json names a finding that expected.json lacks: ${item}`,
    );
  }
  const kept = expected.filter(item => !lowered.has(place(item)));
  const { warnings, transformed } = await buildVite(expectedLowered.target);
  assert.deepEqual(transformed.sort(), sources, 'Vite builds every source of the fixture');
  compare(`Vite with the target ${expectedLowered.target}`, findingsOf('Vite', warnings), kept);
});

// The own entries of the oracle of the report of unused entries, inline, as the `allow` option takes them. They
// replace compatgate.jsonc: the first four are its entries, the others give the report something to name.
const ORACLE_ALLOW: NonNullable<CompatgateBundlerOptions['allow']> = [
  'javascript.builtins.Promise.withResolvers',
  { feature: 'javascript.builtins.Array.fromAsync', packages: ['pkg-a'] },
  { feature: 'api.CompressionStream.CompressionStream', files: ['src/legacy/**'] },
  { feature: 'api.DecompressionStream.DecompressionStream', packages: ['pkg-b'], files: ['**/dist/**'] },
  // Syntax: Vite lowers it for safari15.6, rspack with SWC for esnext keeps it.
  'javascript.classes.static.initialization_blocks',
  // An API: the lowering keeps it.
  'javascript.builtins.Intl.Segmenter',
  // Used by no module.
  'api.Serial',
];

const UNUSED = /allow entries that suppressed no finding/;

/** The findings of a build and the indexes of the `allow` option that its report of unused entries names. */
function reportOf(tool: string, messages: readonly string[]): { findings: string[]; unused: number[] } {
  const texts = messages.map(text => stripVTControlCharacters(text));
  const unused = texts
    .filter(text => UNUSED.test(text))
    .flatMap(text => [...text.matchAll(/compatgate\.allow\[(\d+)\]/g)].map(match => Number(match[1])));
  const findings = findingsOf(
    tool,
    texts.filter(text => !UNUSED.test(text)),
  ).map(item => `${place(item)} ${item.confidence}`);
  return { findings: findings.sort(), unused: unused.sort((a, b) => a - b) };
}

/**
 * The definition of the report: an entry is needed when the build without it reports a finding that the build with
 * it does not. The report may miss an entry, but it never names a needed one. In this fixture it misses none.
 */
async function checkReport(tool: string, build: (allow: typeof ORACLE_ALLOW) => Promise<string[]>): Promise<void> {
  const full = reportOf(tool, await build(ORACLE_ALLOW));
  const notNeeded: number[] = [];
  for (let index = 0; index < ORACLE_ALLOW.length; index += 1) {
    const without = reportOf(tool, await build(ORACLE_ALLOW.filter((_, other) => other !== index)));
    const added = without.findings.filter(item => !full.findings.includes(item));
    if (added.length === 0) {
      notNeeded.push(index);
    }
  }
  assert.deepEqual(full.unused, notNeeded, `${tool}: the report of unused entries against the builds without each`);
}

test('the report of unused entries of rspack names exactly the entries that no finding needs', async () => {
  await checkReport('rspack', async allow => {
    const json = (await buildRspack({ ...OPTIONS, allow })).toJson({ all: false, errors: true, warnings: true });
    return [...(json.errors ?? []), ...(json.warnings ?? [])].map(item => item.message);
  });
});

test('the report of unused entries of Vite that lowers names exactly the entries that no finding needs', async () => {
  await checkReport('Vite', async allow => (await buildVite(expectedLowered.target, { ...OPTIONS, allow })).warnings);
});

function buildRspack(options: CompatgateBundlerOptions = OPTIONS): Promise<Stats> {
  const swc = (syntax: 'ecmascript' | 'typescript') => ({
    loader: 'builtin:swc-loader',
    options: { jsc: { parser: { syntax }, target: 'esnext' } },
  });
  const config: RspackOptions = {
    mode: 'none',
    context: fixture,
    entry: './src/index.ts',
    target: 'web',
    // The loaders make source maps, and the plugin maps a finding to the source through them.
    devtool: 'source-map',
    output: { path: join(output, 'rspack') },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
      rules: [
        { test: /\.ts$/, use: swc('typescript') },
        { test: /\.js$/, use: swc('ecmascript') },
      ],
    },
    plugins: [compatgateRspack(options)],
  };
  const compiler = rspack(config);
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close(() => (error || !stats ? reject(error ?? new Error('rspack gave no stats')) : resolve(stats)));
    });
  });
}

async function buildVite(target: string, options: CompatgateBundlerOptions = OPTIONS) {
  const warnings: string[] = [];
  const transformed = new Set<string>();
  // Records the modules of the fixture that reach the transforms. Virtual modules, such as the runtime of
  // Rolldown, are no files.
  const record: Plugin = {
    name: 'conformance-record',
    enforce: 'post',
    transform(_code, id) {
      const name = fixtureName(id.replace(/[?#].*$/, ''));
      if (name !== undefined) {
        transformed.add(name);
      }
    },
  };
  await viteBuild({
    root: fixture,
    configFile: false,
    envDir: false,
    cacheDir: join(output, `vite-cache-${target}`),
    logLevel: 'warn',
    customLogger: logger(warnings),
    plugins: [record, compatgateVite(options)],
    build: {
      write: false,
      target,
      minify: false,
      rolldownOptions: { input: join(fixture, 'src/index.ts') },
    },
  });
  return { warnings, transformed: [...transformed] };
}

/** A logger of Vite that keeps the warnings and drops the rest. */
function logger(warnings: string[]): Logger {
  const keep = (text: string) => warnings.push(text);
  return {
    hasWarned: false,
    info() {},
    warn: keep,
    warnOnce: keep,
    error() {},
    clearScreen() {},
    hasErrorLogged: () => false,
  };
}
