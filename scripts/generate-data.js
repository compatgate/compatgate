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

export function browserSupport(statements) {
  let full = UNSUPPORTED;
  let partial = UNSUPPORTED;
  let note = null;
  for (const statement of [].concat(statements ?? [])) {
    // "preview" removal takes the feature out of a preview build only; stable releases still have it.
    const removed = statement.version_removed && statement.version_removed !== 'preview';
    // Support behind a flag, a prefix or an old name is not available to ordinary code.
    if (statement.flags || statement.prefix || statement.alternative_name || removed) {
      continue;
    }
    const version = encodeVersion(statement.version_added);
    if (statement.partial_implementation) {
      if (version < partial) {
        partial = version;
        note = noteText(statement.notes);
      }
    } else {
      full = Math.min(full, version);
    }
  }
  return { full, partial, note };
}

export function noteText(notes) {
  const [first] = [].concat(notes ?? []);
  if (typeof first !== 'string') {
    return null;
  }
  return first
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function collectFeatures(data) {
  const features = [];
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '__compat') {
        const support = BROWSERS.map(([bcdKey]) => browserSupport(value.support?.[bcdKey]));
        features.push({
          id: path,
          full: support.map(s => s.full),
          partial: support.map(s => s.partial),
          notes: support.map(s => s.note),
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
        members.push({ name, id: `javascript.builtins.${object}.${name}`, reportable: !accessor });
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

export function renderRust(features, bcdVersion, members, singletons) {
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
    lines.push(`    (${literal(feature.id)}, [${feature.full.map(value).join(', ')}]),`);
  }
  const notes = [];
  lines.push('];', '', 'pub static PARTIAL: &[(u32, u8, u32, u32)] = &[');
  features.forEach((feature, featureIndex) => {
    feature.partial.forEach((version, browserIndex) => {
      if (version !== UNSUPPORTED) {
        const note = feature.notes?.[browserIndex];
        const noteIndex = note ? notes.push(note) - 1 : 'U';
        lines.push(`    (${featureIndex}, ${browserIndex}, ${version}, ${noteIndex}),`);
      }
    });
  });
  lines.push('];', '', 'pub static NOTES: &[&str] = &[');
  for (const note of notes) {
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
  const text = renderRust(
    features,
    packageJson.version,
    collectInstanceMembers(data),
    collectSingletons(webTypes, featureIds),
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
