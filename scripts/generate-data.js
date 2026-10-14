import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
 * `unreleased` holds the BCD version strings of releases that are not out yet: a removal there is no removal.
 */
export function browserSupport(statements, id, unreleased = new Set()) {
  const usable = [];
  for (const statement of [].concat(statements ?? [])) {
    // Support behind a flag, a prefix or an old name is not available to ordinary code.
    if (statement.flags || statement.prefix || statement.alternative_name) {
      continue;
    }
    const added = encodeVersion(statement.version_added);
    // A removal in a preview build or in a release that is not out yet takes the feature out of no
    // stable release: every released version still has it. The release keys have no `≤` of a ranged version.
    const removedIn = typeof statement.version_removed === 'string' ? statement.version_removed.replace(/^≤/, '') : '';
    const removed =
      statement.version_removed && statement.version_removed !== 'preview' && !unreleased.has(removedIn)
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
    const note = partial ? noteText(statement.notes, id) : null;
    // The Rust table needs one row per range. The first statement with a note wins:
    // a statement without a note must not hide the note of an equal statement.
    const same = ranges.find(range => range.added === added && range.removed === removed && range.partial === partial);
    if (!same) {
      ranges.push({ added, removed, partial, note });
    } else if (!same.note) {
      same.note = note;
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

// BCD release statuses of versions that are not out yet. "current", "retired" and "esr" are out.
const UNRELEASED_STATUSES = new Set(['beta', 'nightly', 'planned']);

/** The versions of each browser in `BROWSERS` order that BCD lists as not out yet. */
function unreleasedVersions(browsers) {
  return BROWSERS.map(
    ([bcdKey]) =>
      new Set(
        Object.entries(browsers?.[bcdKey]?.releases ?? {})
          .filter(([, release]) => UNRELEASED_STATUSES.has(release.status))
          .map(([version]) => version),
      ),
  );
}

export function collectFeatures(data) {
  const features = [];
  const unreleased = unreleasedVersions(data.browsers);
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '__compat') {
        const support = BROWSERS.map(([bcdKey], index) =>
          browserSupport(value.support?.[bcdKey], path, unreleased[index]),
        );
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
// The source is the lib.es*.d.ts files of the `typescript` devDependency, pinned in the root package.json:
// there these members are properties (`readonly description: string | undefined;`), not methods.
// `checkAccessors` compares the list with those files on every run of the generator. It fails when a prototype
// member of a builtin without a "get-" or "set-" anchor is a property there but is missing from the list,
// and when a member of the list is not a property there or is not a prototype member in BCD.
export const ACCESSORS = new Set([
  'javascript.builtins.Error.message',
  'javascript.builtins.Error.name',
  'javascript.builtins.Object.constructor',
  'javascript.builtins.Symbol.description',
]);

// Methods of these objects share names with methods of frameworks: `use` of Vue and express,
// `dispose` of three.js. A finding for `app.use()` would be noise. The globals detector checks the constructors.
const UNREPORTED_OBJECTS = new Set(['DisposableStack', 'AsyncDisposableStack']);

function* prototypeMembers(data) {
  for (const [object, node] of Object.entries(data.javascript.builtins)) {
    for (const [name, value] of Object.entries(node)) {
      if (name === '__compat' || name === object || !IDENTIFIER.test(name)) {
        continue;
      }
      // BCD does not mark prototype members, but their spec anchors do: "sec-array.prototype.tosorted".
      const specUrls = [].concat(value.__compat?.spec_url ?? []);
      if (specUrls.some(url => /\.prototype\./i.test(url))) {
        const accessor = specUrls.some(url => /#sec-(get|set)-/i.test(url));
        yield { object, name, id: `javascript.builtins.${object}.${name}`, accessor };
      }
    }
  }
}

export function collectInstanceMembers(data) {
  const members = [];
  for (const { object, name, id, accessor } of prototypeMembers(data)) {
    // An accessor such as `ArrayBuffer.prototype.detached` is never called, so `x.detached()` is not it.
    // It still makes the name ambiguous: a supported accessor of the same name hides the method.
    const reportable = !accessor && !ACCESSORS.has(id) && !UNREPORTED_OBJECTS.has(object);
    members.push({ name, id, reportable });
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

/**
 * Members of the interfaces in TypeScript lib files, as a map from "Interface.member" to the kinds of its
 * declarations: "method" or "property". A getter (`get size(): number;`) is a property.
 * Interfaces inside `declare global` count too: lib.es2025.iterator.d.ts declares `IteratorObject` there.
 */
export function collectLibMembers(declarations) {
  const members = new Map();
  let block = null;
  // A file with CRLF line ends would leave "\r" after "{" and break the checks of the header.
  for (const line of declarations.split(/\r?\n/)) {
    if (!block) {
      const header = /^( *)interface (\w+)/.exec(line);
      if (!header || line.endsWith('{}')) {
        continue;
      }
      // A header that continues on the next line would hide the members of the interface from the check.
      if (!line.endsWith('{')) {
        throw new Error(`Interface header does not end with "{" on the same line: ${line}`);
      }
      block = { name: header[2], indent: `${header[1]}    `, end: `${header[1]}}` };
      continue;
    }
    if (line.startsWith(block.end)) {
      block = null;
      continue;
    }
    // Deeper lines belong to a member type or a multi-line signature.
    if (!line.startsWith(block.indent) || line[block.indent.length] === ' ') {
      continue;
    }
    const match = /^(?:readonly )?(?:(get|set) )?([A-Za-z_$][\w$]*)\??\s*([(<:])/.exec(line.slice(block.indent.length));
    if (!match) {
      continue;
    }
    const kind = match[1] || match[3] === ':' ? 'property' : 'method';
    const key = `${block.name}.${match[2]}`;
    members.set(key, (members.get(key) ?? new Set()).add(kind));
  }
  return members;
}

// BCD objects without a TypeScript interface of the same name, and the interface that declares their members.
const LIB_INTERFACES = { TypedArray: 'Int8Array', Iterator: 'IteratorObject' };

/** Throws when `accessors` does not match the TypeScript lib files `declarations`. See `ACCESSORS`. */
export function checkAccessors(data, declarations, accessors = ACCESSORS) {
  const lib = collectLibMembers(declarations);
  const problems = [];
  const found = new Set();
  for (const { object, name, id, accessor } of prototypeMembers(data)) {
    if (accessor) {
      continue;
    }
    const kinds = lib.get(`${LIB_INTERFACES[object] ?? object}.${name}`) ?? new Set();
    if (accessors.has(id)) {
      found.add(id);
      if (kinds.has('method') || !kinds.has('property')) {
        problems.push(`${id} is in ACCESSORS, but TypeScript does not declare it as a property only`);
      }
    } else if (kinds.has('property')) {
      problems.push(`${id} is a property in TypeScript, but ACCESSORS does not name it`);
    }
  }
  for (const id of accessors) {
    if (!found.has(id)) {
      problems.push(`${id} is in ACCESSORS, but BCD has no such prototype member without a "get-" or "set-" anchor`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`ACCESSORS does not match the TypeScript lib files:\n${problems.join('\n')}`);
  }
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
  // A file with CRLF line ends would leave "\r" after "{" and break the checks of the header.
  for (const line of declarations.split(/\r?\n/)) {
    const declaration = /^interface (\w+)(.*)$/.exec(line);
    if (!declaration) {
      continue;
    }
    const [header, name, rest] = declaration;
    // The parser reads one line. A header that continues on the next line would lose its parents.
    // A one-line declaration ends with an empty body: `interface X extends Y {}`.
    const body = [' {', ' {}'].find(end => header.endsWith(end));
    if (!body) {
      throw new Error(`Interface header does not end with "{" on the same line: ${header}`);
    }
    if (!featureIds.has(`api.${name}`)) {
      continue;
    }
    // Drop type arguments and parameters, innermost first: `<T extends Element>`, `ReadonlyMap<string, X>`.
    let clause = rest.slice(0, -body.length);
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

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// u16::MAX marks "no feature" in `GLOBALS`, so an index must stay below it.
function fitU16(value, what) {
  if (value >= 0xffff) {
    throw new Error(`A ${what} does not fit u16: ${value}`);
  }
  return value;
}

/**
 * `name` and the interfaces that it extends, breadth-first, each once. `parents` maps an interface to its
 * direct parents. Parents can be mixins without BCD rows, and two parents can share a parent. A mixin has
 * no entry in `collectInterfaceParents`, so the walk does not go past it. A member of an interface earlier
 * in the list wins over a member of the same name later in it.
 */
export function ancestry(name, parents) {
  const order = [name];
  for (let index = 0; index < order.length; index++) {
    for (const parent of parents.get(order[index]) ?? []) {
      if (!order.includes(parent)) {
        order.push(parent);
      }
    }
  }
  return order;
}

/** The ids of `featureIds` with `count` dot-separated parts that start with `prefix`, as lists of parts. */
function idsWithParts(featureIds, prefix, count) {
  return [...featureIds]
    .map(id => id.split('.'))
    .filter(parts => parts.length === count && prefix.every((part, index) => parts[index] === part));
}

/**
 * Bare global names: `structuredClone`, `Array`, `when`. `plain` is the feature of a read and `constructed`
 * the feature of `new X()`, or null. A builtin wins over an interface: `javascript.builtins.X`, then
 * `api.X`. For `new X()` the constructor entry `api.X.X` comes first. Members of the global object come
 * last: `name` is `api.Window.name`, and `when` is inherited, `api.EventTarget.when`. Rows are sorted by
 * name for a binary search. Rust compares bytes, and the ids are ASCII, so the orders agree.
 */
export function collectGlobals(featureIds, interfaceParents) {
  const ids = new Set(featureIds);
  const window = ancestry('Window', new Map(interfaceParents.map(({ name, parents }) => [name, parents])));
  const names = new Set([
    ...idsWithParts(ids, ['javascript', 'builtins'], 3).map(parts => parts[2]),
    ...idsWithParts(ids, ['api'], 2).map(parts => parts[1]),
    ...idsWithParts(ids, ['api'], 3)
      .filter(parts => parts[1] === parts[2] || window.includes(parts[1]))
      .map(parts => parts[2]),
  ]);
  const first = candidates => candidates.find(id => ids.has(id)) ?? null;
  return [...names].sort(compareText).map(name => {
    const plain = first([`javascript.builtins.${name}`, `api.${name}`, ...window.map(iface => `api.${iface}.${name}`)]);
    return { name, plain, constructed: first([`api.${name}.${name}`]) ?? plain };
  });
}

/**
 * Members of global objects: `navigator.share`, `document.when`, `Object.groupBy`. A singleton such as
 * `navigator` takes the members of its interface and of the parents of the interface, the own entry
 * first: `document.addEventListener` is `api.EventTarget.addEventListener`. Other objects take the rows
 * under their own name: `javascript.builtins.X.m`, then the static member `api.X.m_static`, then
 * `api.X.m`. Rows are sorted by object and member for a binary search.
 */
export function collectMembers(featureIds, singletons, interfaceParents) {
  const ids = new Set(featureIds);
  const parents = new Map(interfaceParents.map(({ name, parents: list }) => [name, list]));
  const byInterface = new Map();
  for (const [, iface, member] of idsWithParts(ids, ['api'], 3)) {
    if (!byInterface.has(iface)) {
      byInterface.set(iface, []);
    }
    byInterface.get(iface).push(member);
  }
  const rows = new Map();
  const add = (object, member, id) => {
    const key = `${object} ${member}`;
    if (!rows.has(key)) {
      rows.set(key, { object, member, id });
    }
  };
  for (const { name, type } of singletons) {
    for (const iface of ancestry(type, parents)) {
      for (const member of byInterface.get(iface) ?? []) {
        add(name, member, `api.${iface}.${member}`);
      }
    }
  }
  const isSingleton = new Set(singletons.map(({ name }) => name));
  const candidates = [
    ...idsWithParts(ids, ['javascript', 'builtins'], 4).map(parts => [parts[2], parts[3]]),
    ...idsWithParts(ids, ['api'], 3).flatMap(([, object, member]) =>
      member.endsWith('_static')
        ? [
            [object, member],
            [object, member.slice(0, -'_static'.length)],
          ]
        : [[object, member]],
    ),
  ];
  for (const [object, member] of candidates) {
    if (isSingleton.has(object)) {
      continue;
    }
    const id = [
      `javascript.builtins.${object}.${member}`,
      `api.${object}.${member}_static`,
      `api.${object}.${member}`,
    ].find(candidate => ids.has(candidate));
    add(object, member, id);
  }
  return [...rows.values()].sort((a, b) => compareText(a.object, b.object) || compareText(a.member, b.member));
}

export function renderRust(features, bcdVersion, instanceMembers, globals, members) {
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
  const rows = instanceMembers
    .filter(member => index.has(member.id))
    .map(member => ({ ...member, featureIndex: index.get(member.id) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.featureIndex - b.featureIndex));
  lines.push('];', '', 'pub static INSTANCE_MEMBERS: &[(&str, u32, bool)] = &[');
  for (const row of rows) {
    lines.push(`    (${literal(row.name)}, ${row.featureIndex}, ${row.reportable}),`);
  }
  // A global or a member names a feature by its index. A missing id is a bug in the generator.
  const featureIndex = id => {
    if (!index.has(id)) {
      throw new Error(`Unknown feature id in a table of globals: ${id}`);
    }
    return fitU16(index.get(id), 'feature index');
  };
  // With BCD 8.1.4 every name has a feature of a read, so no row of the real data needs it.
  const optionalIndex = id => (id === null ? 'u16::MAX' : featureIndex(id));
  // The tables of globals hold indices instead of `&str`: a `&str` in a static costs 16 bytes and, in a
  // shared library on Linux, a relocation of 24 bytes. Names sort by bytes, so the index order is the
  // string order, and Rust compares indices where it would compare strings.
  const names = [
    ...new Set([...globals.map(({ name }) => name), ...members.flatMap(row => [row.object, row.member])]),
  ].sort(compareText);
  const nameIndex = new Map(names.map((name, position) => [name, fitU16(position, 'name index')]));
  const starts = [0];
  for (const name of names) {
    // A name of the data is ASCII, so its length in UTF-16 units is its length in bytes.
    if (!/^[\x20-\x7e]+$/.test(name)) {
      throw new Error(`Name of a global is not ASCII: ${JSON.stringify(name)}`);
    }
    starts.push(starts.at(-1) + name.length);
  }
  lines.push(
    '];',
    '',
    '// Names of globals, objects and members, sorted by bytes. Name `i` is `NAMES[NAME_STARTS[i]..NAME_STARTS[i + 1]]`.',
    'pub static NAMES: &str = concat!(',
  );
  for (const name of names) {
    lines.push(`    ${literal(name)},`);
  }
  lines.push(');', '', 'pub static NAME_STARTS: &[u32] = &[');
  for (let position = 0; position < starts.length; position += 16) {
    lines.push(`    ${starts.slice(position, position + 16).join(', ')},`);
  }
  lines.push(
    '];',
    '',
    '// Name, feature of a read, feature of `new`; `u16::MAX` is none.',
    'pub static GLOBALS: &[(u16, u16, u16)] = &[',
  );
  for (const { name, plain, constructed } of globals) {
    lines.push(`    (${nameIndex.get(name)}, ${optionalIndex(plain)}, ${optionalIndex(constructed)}), // ${name}`);
  }
  // `members` is sorted by object and member, so the rows of an object are consecutive.
  const objects = [];
  const memberRows = [];
  members.forEach(({ object, member, id }, position) => {
    if (objects.at(-1)?.object !== object) {
      objects.push({ object, first: fitU16(position, 'member row') });
    }
    memberRows.push(`    (${nameIndex.get(member)}, ${featureIndex(id)}), // ${object}.${member}`);
  });
  lines.push(
    '];',
    '',
    '// Object name, first row in `MEMBER_ROWS`. The rows of an object end at the first row of the next object.',
    'pub static MEMBER_OBJECTS: &[(u16, u16)] = &[',
  );
  for (const { object, first } of objects) {
    lines.push(`    (${nameIndex.get(object)}, ${first}), // ${object}`);
  }
  lines.push(
    '];',
    '',
    '// Member name, feature; sorted by the name within an object.',
    'pub static MEMBER_ROWS: &[(u16, u16)] = &[',
    ...memberRows,
  );
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
  // TypeScript 7 keeps its lib files in the package for the platform, next to the compiler binary.
  const platform = `${process.platform}-${process.arch}`;
  let platformPackage;
  try {
    platformPackage = createRequire(require.resolve('typescript/package.json')).resolve(
      `@typescript/typescript-${platform}/package.json`,
    );
  } catch (cause) {
    throw new Error(
      `TypeScript lib files not found for ${platform}: install typescript with its optional platform package`,
      { cause },
    );
  }
  const libDirectory = join(dirname(platformPackage), 'lib');
  const libFiles = readdirSync(libDirectory)
    .filter(name => /^lib\.es[\w.]*\.d\.ts$/.test(name))
    .sort();
  checkAccessors(data, libFiles.map(name => readFileSync(join(libDirectory, name), 'utf8')).join('\n'));
  const interfaceParents = collectInterfaceParents(webTypes, featureIds);
  const text = renderRust(
    features,
    packageJson.version,
    collectInstanceMembers(data),
    collectGlobals(featureIds, interfaceParents),
    collectMembers(featureIds, collectSingletons(webTypes, featureIds), interfaceParents),
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
