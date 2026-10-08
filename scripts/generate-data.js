import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The order is the column order of the generated tables.
// It must match `Browser::ALL` in crates/compatgate/src/data.rs; a Rust test compares them.
export const BROWSERS = [
  ['chrome', 'Chrome'],
  ['chrome_android', 'ChromeAndroid'],
  ['edge', 'Edge'],
  ['firefox', 'Firefox'],
  ['firefox_android', 'FirefoxAndroid'],
  ['opera', 'Opera'],
  ['opera_android', 'OperaAndroid'],
  ['safari', 'Safari'],
  ['safari_ios', 'SafariIos'],
  ['samsunginternet_android', 'SamsungInternetAndroid'],
  ['webview_android', 'WebviewAndroid'],
];

export const UNSUPPORTED = 0xffffffff;

export function encodeVersion(value) {
  if (value === true) {
    return 0;
  }
  if (typeof value !== 'string') {
    return UNSUPPORTED;
  }
  const match = /^≤?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  if (!match) {
    return UNSUPPORTED;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (major > 0xffff || minor > 0xff || patch > 0xff) {
    throw new Error(`Version out of range: ${value}`);
  }
  return ((major << 16) | (minor << 8) | patch) >>> 0;
}

/**
 * The support of one browser as ranges of versions. `since` is the first version from which full support
 * lasts to the latest release, or `UNSUPPORTED`. `ranges` holds the statements that start before `since`:
 * partial support and full support that a later release removed. A statement is the range
 * `[added, removed)`; without a removal it lasts to the latest release, and `removed` is `UNSUPPORTED`.
 */
export function browserSupport(statements, id) {
  const usable = [];
  for (const statement of [].concat(statements ?? [])) {
    // Support behind a flag, a prefix or an old name is not available to ordinary code.
    if (statement.flags || statement.prefix || statement.alternative_name) {
      continue;
    }
    const added = encodeVersion(statement.version_added);
    // "preview" removal takes the feature out of a preview build only; stable releases still have it.
    const removed =
      statement.version_removed && statement.version_removed !== 'preview'
        ? encodeVersion(statement.version_removed)
        : UNSUPPORTED;
    if (added === UNSUPPORTED || added >= removed) {
      continue;
    }
    usable.push({ added, removed, partial: Boolean(statement.partial_implementation), statement });
  }
  // Full ranges that overlap or touch form one span. The span that reaches the latest release starts at `since`.
  let since = UNSUPPORTED;
  const full = usable.filter(range => !range.partial).sort((a, b) => b.removed - a.removed || a.added - b.added);
  for (const range of full) {
    if (range.removed >= since && range.added < since) {
      since = range.added;
    }
  }
  const ranges = [];
  for (const { added, removed, partial, statement } of usable) {
    if (added >= since) {
      continue;
    }
    // The Rust table needs one row per range; the first statement of a range wins.
    if (!ranges.some(range => range.added === added && range.removed === removed && range.partial === partial)) {
      ranges.push({ added, removed, partial, note: partial ? noteText(statement.notes, id) : null });
    }
  }
  ranges.sort((a, b) => a.added - b.added || a.removed - b.removed || Number(a.partial) - Number(b.partial));
  return { since, ranges };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

export function noteText(notes, id) {
  const [first] = [].concat(notes ?? []);
  if (typeof first !== 'string') {
    return null;
  }
  const text = first.replace(/<[^>]+>/g, '');
  // One pass decodes every entity, so a decoded "&" never starts another entity.
  // A non-breaking space becomes a plain space: Rust would need a \u escape for it.
  return text
    .replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, name) => {
      if (name !== undefined) {
        if (!Object.hasOwn(ENTITIES, name)) {
          throw new Error(`Unknown HTML entity ${entity} in a note of ${id}: ${first}`);
        }
        return ENTITIES[name];
      }
      const codePoint = decimal !== undefined ? Number(decimal) : parseInt(hex, 16);
      if (codePoint > 0x10ffff) {
        throw new Error(`Invalid HTML entity ${entity} in a note of ${id}: ${first}`);
      }
      return String.fromCodePoint(codePoint);
    })
    .replace(/\s+/g, ' ')
    .trim();
}

export function collectFeatures(data) {
  const features = [];
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '__compat') {
        const support = BROWSERS.map(([bcdKey]) => browserSupport(value.support?.[bcdKey], path));
        features.push({
          id: path,
          since: support.map(s => s.since),
          ranges: support.map(s => s.ranges),
        });
      } else if (value && typeof value === 'object') {
        walk(value, path ? `${path}.${key}` : key);
      }
    }
  };
  walk({ api: data.api, javascript: data.javascript }, '');
  for (const feature of features) {
    // Rust compares `&str` by bytes and JavaScript compares strings by UTF-16 units.
    // Both orders agree only for ASCII ids, so the binary search in Rust depends on this check.
    if (!/^[\x20-\x7e]+$/.test(feature.id)) {
      throw new Error(`Feature id is not ASCII: ${feature.id}`);
    }
  }
  return features.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const IDENTIFIER = /^[A-Za-z$][\w$]*$/;

// Prototype members that are never called, although their spec anchors have no "get-" prefix:
// `Symbol.prototype.description` has the anchor "sec-symbol.prototype.description".
// The list comes from the lib.es*.d.ts files of TypeScript 7.0.2: there these members are properties
// (`readonly description: string | undefined;`), not methods. Recheck it when BCD adds prototype members.
export const ACCESSORS = new Set([
  'javascript.builtins.Error.message',
  'javascript.builtins.Error.name',
  'javascript.builtins.Object.constructor',
  'javascript.builtins.Symbol.description',
]);

// Methods of these objects share names with methods of frameworks: `use` of Vue and express,
// `dispose` of three.js. A finding for `app.use()` would be noise. The globals detector checks the constructors.
const UNREPORTED_OBJECTS = new Set(['DisposableStack', 'AsyncDisposableStack']);

export function collectInstanceMembers(data) {
  const members = [];
  for (const [object, node] of Object.entries(data.javascript.builtins)) {
    for (const [name, value] of Object.entries(node)) {
      if (name === '__compat' || name === object || !IDENTIFIER.test(name)) {
        continue;
      }
      // BCD does not mark prototype members, but their spec anchors do: "sec-array.prototype.tosorted".
      const specUrls = [].concat(value.__compat?.spec_url ?? []);
      if (specUrls.some(url => /\.prototype\./i.test(url))) {
        // An accessor such as `ArrayBuffer.prototype.detached` is never called, so `x.detached()` is not it.
        // It still makes the name ambiguous: a supported accessor of the same name hides the method.
        const accessor = specUrls.some(url => /#sec-(get|set)-/i.test(url));
        const id = `javascript.builtins.${object}.${name}`;
        const reportable = !accessor && !ACCESSORS.has(id) && !UNREPORTED_OBJECTS.has(object);
        members.push({ name, id, reportable });
      }
    }
  }
  for (const [iface, node] of Object.entries(data.api)) {
    for (const name of Object.keys(node)) {
      // An underscore marks static members, events and sub-features such as `secure_context_required`.
      if (name === '__compat' || name === iface || name.includes('_') || !IDENTIFIER.test(name)) {
        continue;
      }
      members.push({ name, id: `api.${iface}.${name}`, reportable: false });
    }
  }
  return members;
}

export function collectSingletons(declarations, featureIds) {
  const singletons = [];
  for (const [, name, type] of declarations.matchAll(
    /^declare var (\w+): (\w+)(?: \| null| & typeof globalThis)?;$/gm,
  )) {
    if (name !== type && featureIds.has(`api.${type}`)) {
      singletons.push({ name, type });
    }
  }
  return singletons.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function collectInterfaceParents(declarations, featureIds) {
  const parents = new Map();
  // Only top-level declarations: interfaces inside `declare namespace` are indented.
  for (const [header, name, rest] of declarations.matchAll(/^interface (\w+)(.*)$/gm)) {
    // The parser reads one line. A header that continues on the next line would lose its parents.
    if (!header.endsWith(' {')) {
      throw new Error(`Interface header does not end with "{" on the same line: ${header}`);
    }
    if (!featureIds.has(`api.${name}`)) {
      continue;
    }
    // Drop type arguments and parameters, innermost first: `<T extends Element>`, `ReadonlyMap<string, X>`.
    let clause = rest.slice(0, -' {'.length);
    while (/<[^<>]*>/.test(clause)) {
      clause = clause.replace(/<[^<>]*>/g, '');
    }
    const match = /^\s*extends (.+)$/.exec(clause);
    if (!match) {
      continue;
    }
    // TypeScript merges repeated declarations of an interface, and so does this table.
    const list = parents.get(name) ?? [];
    for (const parent of match[1].split(',').map(part => part.trim())) {
      if (!list.includes(parent)) {
        list.push(parent);
      }
    }
    parents.set(name, list);
  }
  return [...parents]
    .map(([name, list]) => ({ name, parents: list }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function renderRust(features, bcdVersion, members, singletons, interfaceParents) {
  const value = version => (version === UNSUPPORTED ? 'U' : String(version));
  const literal = text => {
    const json = JSON.stringify(text);
    // JSON and Rust share escapes for quotes and backslashes, but not \uXXXX.
    if (json.includes('\\u')) {
      throw new Error(`Text needs a \\u escape, which Rust writes differently: ${text}`);
    }
    return json;
  };
  const lines = [
    '// @generated by scripts/generate-data.js from @mdn/browser-compat-data and @types/web. Do not edit.',
    '',
    'const U: u32 = u32::MAX;',
    '',
    `pub const BCD_VERSION: &str = ${literal(bcdVersion)};`,
    '',
    '// Only a test reads this table: it checks that `Browser::ALL` follows the column order.',
    '#[cfg_attr(not(test), allow(dead_code))]',
    `pub const BROWSER_KEYS: [&str; ${BROWSERS.length}] = [${BROWSERS.map(([key]) => literal(key)).join(', ')}];`,
    '',
    `pub static FEATURES: &[(&str, [u32; ${BROWSERS.length}])] = &[`,
  ];
  for (const feature of features) {
    lines.push(`    (${literal(feature.id)}, [${feature.since.map(value).join(', ')}]),`);
  }
  const notes = new Map();
  lines.push(
    '];',
    '',
    '// Feature index, browser column, first version, version of removal, partial, index into `NOTES`.',
    'pub static RANGES: &[(u32, u8, u32, u32, bool, u32)] = &[',
  );
  features.forEach((feature, featureIndex) => {
    feature.ranges.forEach((ranges, browserIndex) => {
      for (const { added, removed, partial, note } of ranges) {
        if (note && !notes.has(note)) {
          notes.set(note, notes.size);
        }
        const noteIndex = note ? notes.get(note) : 'U';
        lines.push(`    (${featureIndex}, ${browserIndex}, ${added}, ${value(removed)}, ${partial}, ${noteIndex}),`);
      }
    });
  });
  lines.push('];', '', 'pub static NOTES: &[&str] = &[');
  for (const note of notes.keys()) {
    lines.push(`    ${literal(note)},`);
  }
  const index = new Map(features.map((feature, featureIndex) => [feature.id, featureIndex]));
  const rows = members
    .filter(member => index.has(member.id))
    .map(member => ({ ...member, featureIndex: index.get(member.id) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.featureIndex - b.featureIndex));
  lines.push('];', '', 'pub static INSTANCE_MEMBERS: &[(&str, u32, bool)] = &[');
  for (const row of rows) {
    lines.push(`    (${literal(row.name)}, ${row.featureIndex}, ${row.reportable}),`);
  }
  lines.push('];', '', 'pub static SINGLETONS: &[(&str, &str)] = &[');
  for (const singleton of singletons) {
    lines.push(`    (${literal(singleton.name)}, ${literal(singleton.type)}),`);
  }
  lines.push('];', '', 'pub static INTERFACE_PARENTS: &[(&str, &[&str])] = &[');
  for (const { name, parents } of interfaceParents) {
    lines.push(`    (${literal(name)}, &[${parents.map(literal).join(', ')}]),`);
  }
  lines.push('];', '');
  return lines.join('\n');
}

if (import.meta.main) {
  const require = createRequire(import.meta.url);
  const data = require('@mdn/browser-compat-data');
  const packageJson = JSON.parse(
    readFileSync(join(dirname(require.resolve('@mdn/browser-compat-data')), 'package.json'), 'utf8'),
  );
  if (packageJson.name !== '@mdn/browser-compat-data') {
    throw new Error(`Unexpected package next to the BCD data: ${packageJson.name}`);
  }
  const features = collectFeatures(data);
  const output = fileURLToPath(new URL('../crates/compatgate/src/data/generated.rs', import.meta.url));
  const webTypes = readFileSync(require.resolve('@types/web/index.d.ts'), 'utf8');
  const featureIds = new Set(features.map(feature => feature.id));
  for (const id of ACCESSORS) {
    if (!featureIds.has(id)) {
      throw new Error(`ACCESSORS names a feature that BCD does not have: ${id}`);
    }
  }
  const text = renderRust(
    features,
    packageJson.version,
    collectInstanceMembers(data),
    collectSingletons(webTypes, featureIds),
    collectInterfaceParents(webTypes, featureIds),
  );
  if (process.argv.includes('--check')) {
    // CI uses this mode: a BCD update or a generator change without regeneration must fail.
    if (readFileSync(output, 'utf8') !== text) {
      console.error(`${output} is out of date. Run: pnpm generate`);
      process.exit(1);
    }
    console.log(`${output} is up to date with BCD ${packageJson.version}`);
  } else {
    writeFileSync(output, text);
    console.log(`Wrote ${features.length} features from BCD ${packageJson.version} to ${output}`);
  }
}
