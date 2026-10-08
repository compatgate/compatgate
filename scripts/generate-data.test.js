import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESSORS,
  BROWSERS,
  UNSUPPORTED,
  browserSupport,
  checkAccessors,
  collectFeatures,
  collectInstanceMembers,
  collectInterfaceParents,
  collectLibMembers,
  collectSingletons,
  encodeVersion,
  noteText,
  renderRust,
} from './generate-data.js';

test('encodeVersion', () => {
  assert.equal(encodeVersion('15.4'), (15 << 16) | (4 << 8));
  assert.equal(encodeVersion('1.2.3'), (1 << 16) | (2 << 8) | 3);
  assert.equal(encodeVersion('≤79'), 79 << 16);
  assert.equal(encodeVersion(true), 0);
  assert.equal(encodeVersion('preview'), UNSUPPORTED);
  assert.equal(encodeVersion(false), UNSUPPORTED);
  assert.equal(encodeVersion(null), UNSUPPORTED);
});

const V = major => major << 16;

test('browserSupport ignores flags, prefixes and alternative names', () => {
  const support = browserSupport([
    { version_added: '10', flags: [{ type: 'preference' }] },
    { version_added: '11', prefix: 'webkit' },
    { version_added: '12', alternative_name: 'oldName' },
    { version_added: false },
    { version_added: 'preview' },
    { version_added: '20' },
  ]);
  assert.deepEqual(support, { since: V(20), ranges: [] });
});

test('browserSupport keeps a removed statement as a range that ends at the removal', () => {
  const support = browserSupport([
    { version_added: '16' },
    {
      version_added: '14.1',
      version_removed: '16',
      partial_implementation: true,
      notes: 'Parentheses in <code>initializers</code>.',
    },
    { version_added: '14', version_removed: '14.1', partial_implementation: true, notes: 'No static fields.' },
  ]);
  assert.deepEqual(support, {
    since: V(16),
    ranges: [
      { added: V(14), removed: V(14) | (1 << 8), partial: true, note: 'No static fields.' },
      { added: V(14) | (1 << 8), removed: V(16), partial: true, note: 'Parentheses in initializers.' },
    ],
  });
});

test('browserSupport keeps support that was removed and never added again', () => {
  const support = browserSupport([{ version_added: '13', version_removed: '14' }]);
  assert.deepEqual(support, {
    since: UNSUPPORTED,
    ranges: [{ added: V(13), removed: V(14), partial: false, note: null }],
  });
});

test('browserSupport starts full support at the first full range that lasts without a gap', () => {
  const support = browserSupport([
    { version_added: '30' },
    { version_added: '20', version_removed: '30' },
    { version_added: '15', version_removed: '25' },
    { version_added: '5', version_removed: '10' },
  ]);
  assert.deepEqual(support, {
    since: V(15),
    ranges: [{ added: V(5), removed: V(10), partial: false, note: null }],
  });
});

test('browserSupport drops partial ranges that start once full support has begun', () => {
  const support = browserSupport([
    { version_added: '30' },
    { version_added: '25', partial_implementation: true, notes: 'Only on <code>macOS</code>.' },
    { version_added: '35', partial_implementation: true, notes: 'Later.' },
  ]);
  assert.deepEqual(support, {
    since: V(30),
    ranges: [{ added: V(25), removed: UNSUPPORTED, partial: true, note: 'Only on macOS.' }],
  });
});

test('browserSupport sorts ranges and keeps the first statement of equal ranges', () => {
  const support = browserSupport([
    { version_added: '30', partial_implementation: true, notes: 'Later.' },
    { version_added: '25', version_removed: '27', partial_implementation: true, notes: 'Earlier.' },
    { version_added: '30', partial_implementation: true, notes: 'Same range, second statement.' },
    { version_added: '25', partial_implementation: true },
  ]);
  assert.deepEqual(support.ranges, [
    { added: V(25), removed: V(27), partial: true, note: 'Earlier.' },
    { added: V(25), removed: UNSUPPORTED, partial: true, note: null },
    { added: V(30), removed: UNSUPPORTED, partial: true, note: 'Later.' },
  ]);
});

test('browserSupport keeps the statement with a note from two partial statements of one range', () => {
  const support = browserSupport([
    { version_added: '30', partial_implementation: true },
    { version_added: '30', partial_implementation: true, notes: 'Has a note.' },
    { version_added: '20', version_removed: '30', partial_implementation: true, notes: 'First note.' },
    { version_added: '20', version_removed: '30', partial_implementation: true, notes: 'Second note.' },
  ]);
  assert.deepEqual(support.ranges, [
    { added: V(20), removed: V(30), partial: true, note: 'First note.' },
    { added: V(30), removed: UNSUPPORTED, partial: true, note: 'Has a note.' },
  ]);
});

test('browserSupport ignores a removal in a preview build', () => {
  const support = browserSupport([{ version_added: '26.4', version_removed: 'preview' }]);
  assert.deepEqual(support, { since: (26 << 16) | (4 << 8), ranges: [] });
});

test('collectFeatures walks only api and javascript and sorts ids', () => {
  const compat = { support: { chrome: { version_added: '1' } } };
  const features = collectFeatures({
    api: { B: { __compat: compat }, A: { __compat: compat, child: { __compat: compat } } },
    javascript: { builtins: { X: { __compat: compat } } },
    css: { properties: { color: { __compat: compat } } },
  });
  assert.deepEqual(
    features.map(feature => feature.id),
    ['api.A', 'api.A.child', 'api.B', 'javascript.builtins.X'],
  );
  assert.equal(features[0].since.length, BROWSERS.length);
  assert.equal(features[0].since[0], 1 << 16);
  assert.deepEqual(features[0].ranges[0], []);
});

test('renderRust writes all tables', () => {
  const since = BROWSERS.map(() => UNSUPPORTED);
  const ranges = BROWSERS.map((_, index) =>
    index === 2
      ? [
          { added: V(5), removed: V(6), partial: false, note: null },
          { added: V(6), removed: UNSUPPORTED, partial: true, note: 'Only on "macOS".' },
        ]
      : [],
  );
  const text = renderRust(
    [{ id: 'api.A', since, ranges }],
    '1.0.0',
    [{ name: 'm', id: 'api.A', reportable: false }],
    [{ name: 'a', type: 'A' }],
    [{ name: 'A', parents: ['B', 'C'] }],
  );
  assert.match(text, /pub const BCD_VERSION: &str = "1\.0\.0";/);
  assert.match(text, /pub const BROWSER_KEYS: \[&str; 11\] = \["chrome", "chrome_android"/);
  assert.match(text, /\("api\.A", \[U, U, U, U, U, U, U, U, U, U, U\]\),/);
  assert.match(
    text,
    /pub static RANGES: &\[\(u32, u8, u32, u32, bool, u32\)\] = &\[\n {4}\(0, 2, 327680, 393216, false, U\),\n {4}\(0, 2, 393216, U, true, 0\),\n\];/,
  );
  assert.match(text, /pub static NOTES: &\[&str\] = &\[\n {4}"Only on \\"macOS\\"\.",/);
  assert.match(text, /\("m", 0, false\),/);
  assert.match(text, /\("a", "A"\),/);
  assert.match(text, /pub static INTERFACE_PARENTS: &\[\(&str, &\[&str\]\)\] = &\[\n {4}\("A", &\["B", "C"\]\),/);
});

test('renderRust stores each note text once', () => {
  const since = BROWSERS.map(() => UNSUPPORTED);
  const range = note => ({ added: V(5), removed: UNSUPPORTED, partial: true, note });
  const ranges = BROWSERS.map((_, index) => (index < 2 ? [range('Same.')] : []));
  const other = BROWSERS.map((_, index) => (index === 0 ? [{ ...range('Other.'), added: V(7) }] : []));
  const text = renderRust(
    [
      { id: 'api.A', since, ranges },
      { id: 'api.B', since, ranges: other },
    ],
    '1.0.0',
    [],
    [],
    [],
  );
  assert.match(
    text,
    /\(0, 0, 327680, U, true, 0\),\n {4}\(0, 1, 327680, U, true, 0\),\n {4}\(1, 0, 458752, U, true, 1\),/,
  );
  assert.match(text, /pub static NOTES: &\[&str\] = &\[\n {4}"Same\.",\n {4}"Other\.",\n\];/);
});

test('--check passes when the committed data matches the generator output', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, [new URL('./generate-data.js', import.meta.url).pathname, '--check'], {
    encoding: 'utf8',
  });
  assert.match(output, /up to date/);
});

test('noteText strips HTML and takes the first note', () => {
  assert.equal(noteText(['See <a href="https://bugs/1">bug 1</a>.\n  More.', 'Second'], 'api.A'), 'See bug 1. More.');
  assert.equal(noteText(undefined, 'api.A'), null);
});

test('noteText decodes numeric entities and non-breaking spaces', () => {
  assert.equal(
    noteText('It&#39;s &#x27;on&#x27;&nbsp;by default: &lt;b&gt; &amp;&amp; &quot;x&quot;.', 'api.A'),
    "It's 'on' by default: <b> && \"x\".",
  );
  // A decoded ampersand does not start another entity.
  assert.equal(noteText('&amp;lt; and &#38;gt;', 'api.A'), '&lt; and &gt;');
});

test('noteText rejects an unknown named entity and names the feature', () => {
  assert.throws(() => noteText('Wait&hellip;', 'api.A.b'), /&hellip;.*api\.A\.b.*Wait&hellip;/);
});

test('collectInstanceMembers keeps getters and setters of builtins but does not report them', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        ArrayBuffer: {
          detached: compat('https://tc39.es/#sec-get-arraybuffer.prototype.detached'),
          transfer: compat('https://tc39.es/#sec-arraybuffer.prototype.transfer'),
        },
        Example: {
          value: compat(['https://tc39.es/#sec-set-example.prototype.value']),
        },
      },
    },
    api: {},
  });
  assert.deepEqual(members, [
    { name: 'detached', id: 'javascript.builtins.ArrayBuffer.detached', reportable: false },
    { name: 'transfer', id: 'javascript.builtins.ArrayBuffer.transfer', reportable: true },
    { name: 'value', id: 'javascript.builtins.Example.value', reportable: false },
  ]);
});

test('collectInstanceMembers takes prototype members of builtins and members of Web API interfaces', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        Array: {
          Array: compat('https://tc39.es/#sec-array-constructor'),
          from: compat('https://tc39.es/#sec-array.from'),
          toSorted: compat('https://tc39.es/#sec-array.prototype.tosorted'),
          '@@iterator': compat('https://tc39.es/#sec-array.prototype-@@iterator'),
        },
      },
    },
    api: {
      Element: {
        Element: compat(''),
        toggleAttribute: compat(''),
        click_event: compat(''),
        getHTML_static: compat(''),
      },
    },
  });
  assert.deepEqual(members, [
    { name: 'toSorted', id: 'javascript.builtins.Array.toSorted', reportable: true },
    { name: 'toggleAttribute', id: 'api.Element.toggleAttribute', reportable: false },
  ]);
});

test('collectInstanceMembers does not report members that TypeScript declares as properties', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        Symbol: {
          description: compat('https://tc39.es/#sec-symbol.prototype.description'),
          toString: compat('https://tc39.es/#sec-symbol.prototype.tostring'),
        },
      },
    },
    api: {},
  });
  assert.ok(ACCESSORS.has('javascript.builtins.Symbol.description'));
  assert.deepEqual(members, [
    { name: 'description', id: 'javascript.builtins.Symbol.description', reportable: false },
    { name: 'toString', id: 'javascript.builtins.Symbol.toString', reportable: true },
  ]);
});

test('collectInstanceMembers does not report members of DisposableStack and AsyncDisposableStack', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const members = collectInstanceMembers({
    javascript: {
      builtins: {
        DisposableStack: {
          DisposableStack: compat('https://tc39.es/#sec-disposablestack-constructor'),
          dispose: compat('https://tc39.es/#sec-disposablestack.prototype.dispose'),
          use: compat('https://tc39.es/#sec-disposablestack.prototype.use'),
        },
        AsyncDisposableStack: {
          use: compat('https://tc39.es/#sec-asyncdisposablestack.prototype.use'),
        },
      },
    },
    api: {},
  });
  assert.deepEqual(members, [
    { name: 'dispose', id: 'javascript.builtins.DisposableStack.dispose', reportable: false },
    { name: 'use', id: 'javascript.builtins.DisposableStack.use', reportable: false },
    { name: 'use', id: 'javascript.builtins.AsyncDisposableStack.use', reportable: false },
  ]);
});

test('collectInterfaceParents reads extends clauses of interfaces with BCD data', () => {
  const declarations = [
    'interface Document extends Node, DocumentOrShadowRoot, ParentNode {',
    '}',
    'interface HTMLCollectionOf<T extends Element> extends HTMLCollectionBase {',
    '}',
    'interface HTMLCollectionOf<T extends Element> {',
    '}',
    'interface Worker extends EventTarget, AbstractWorker, MessageEventTarget<Worker> {',
    '}',
    'interface Worker extends EventTarget, Extra {',
    '}',
    'interface AudioParamMap extends ReadonlyMap<string, Map<string, AudioParam>> {',
    '}',
    'interface Node extends EventTarget {',
    '}',
    'interface ParentNode extends Node {',
    '}',
    'interface Text {',
    '}',
    'declare namespace WebAssembly {',
    '    interface CompileError extends Error {',
    '    }',
    '}',
  ].join('\n');
  const ids = new Set([
    'api.AudioParamMap',
    'api.CompileError',
    'api.Document',
    'api.HTMLCollectionOf',
    'api.Node',
    'api.Text',
    'api.Worker',
  ]);
  assert.deepEqual(collectInterfaceParents(declarations, ids), [
    { name: 'AudioParamMap', parents: ['ReadonlyMap'] },
    { name: 'Document', parents: ['Node', 'DocumentOrShadowRoot', 'ParentNode'] },
    { name: 'HTMLCollectionOf', parents: ['HTMLCollectionBase'] },
    { name: 'Node', parents: ['EventTarget'] },
    { name: 'Worker', parents: ['EventTarget', 'AbstractWorker', 'MessageEventTarget', 'Extra'] },
  ]);
});

test('collectSingletons maps global variables to interfaces with BCD data', () => {
  const declarations = [
    'declare var navigator: Navigator;',
    'declare var window: Window & typeof globalThis;',
    'declare var visualViewport: VisualViewport | null;',
    'declare var ResizeObserver: {',
    'declare var unknownThing: UnknownInterface;',
  ].join('\n');
  const ids = new Set(['api.Navigator', 'api.Window', 'api.VisualViewport']);
  assert.deepEqual(collectSingletons(declarations, ids), [
    { name: 'navigator', type: 'Navigator' },
    { name: 'visualViewport', type: 'VisualViewport' },
    { name: 'window', type: 'Window' },
  ]);
});

test('collectInterfaceParents rejects an interface header that does not end with a brace', () => {
  const declarations = ['interface Document extends Node,', '    ParentNode {', '}'].join('\n');
  assert.throws(
    () => collectInterfaceParents(declarations, new Set(['api.Document'])),
    /interface Document extends Node,/,
  );
});

test('collectInterfaceParents reads interfaces declared on one line', () => {
  const declarations = [
    'interface Empty {}',
    'interface Child extends Parent {}',
    'interface Generic<T extends Node> extends Base<T>, Mixin {}',
  ].join('\n');
  const ids = new Set(['api.Empty', 'api.Child', 'api.Generic']);
  assert.deepEqual(collectInterfaceParents(declarations, ids), [
    { name: 'Child', parents: ['Parent'] },
    { name: 'Generic', parents: ['Base', 'Mixin'] },
  ]);
});

test('collectLibMembers tells properties from methods in interfaces of the TypeScript libraries', () => {
  const declarations = [
    'interface Symbol {',
    '    /** Returns a string. */',
    '    toString(): string;',
    '    readonly description: string | undefined;',
    '}',
    'interface ArrayBuffer {',
    '    get maxByteLength(): number;',
    '    slice<T>(begin?: number): ArrayBuffer;',
    '    resize?(newByteLength?: number): void;',
    '    [Symbol.toStringTag]: string;',
    '}',
    'interface WeakMap<K extends WeakKey, V> {}',
    'declare global {',
    '    interface IteratorObject<T> {',
    '        map<U>(callbackfn: (value: T) => U): IteratorObject<U>;',
    '    }',
    '}',
    'interface Symbol {',
    '    description(): string;',
    '}',
  ].join('\n');
  const members = collectLibMembers(declarations);
  assert.deepEqual(Object.fromEntries([...members].map(([key, kinds]) => [key, [...kinds].sort()])), {
    'Symbol.toString': ['method'],
    'Symbol.description': ['method', 'property'],
    'ArrayBuffer.maxByteLength': ['property'],
    'ArrayBuffer.slice': ['method'],
    'ArrayBuffer.resize': ['method'],
    'IteratorObject.map': ['method'],
  });
});

test('checkAccessors passes when ACCESSORS names exactly the members that TypeScript declares as properties', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const data = {
    javascript: {
      builtins: {
        Symbol: {
          description: compat('https://tc39.es/#sec-symbol.prototype.description'),
          toString: compat('https://tc39.es/#sec-symbol.prototype.tostring'),
        },
        ArrayBuffer: {
          detached: compat('https://tc39.es/#sec-get-arraybuffer.prototype.detached'),
        },
        TypedArray: {
          toSorted: compat('https://tc39.es/#sec-%typedarray%.prototype.tosorted'),
        },
        Iterator: {
          map: compat('https://tc39.es/#sec-iterator.prototype.map'),
        },
        Date: {
          getYear: compat('https://tc39.es/#sec-date.prototype.getyear'),
        },
      },
    },
  };
  const declarations = [
    'interface Symbol {',
    '    toString(): string;',
    '    readonly description: string | undefined;',
    '}',
    'interface ArrayBuffer {',
    '    readonly detached: boolean;',
    '}',
    'interface Int8Array<TArrayBuffer> {',
    '    toSorted(compareFn?: (a: number, b: number) => number): Int8Array<ArrayBuffer>;',
    '}',
    'interface IteratorObject<T> {',
    '    map<U>(callbackfn: (value: T) => U): IteratorObject<U>;',
    '}',
  ].join('\n');
  assert.doesNotThrow(() => checkAccessors(data, declarations, new Set(['javascript.builtins.Symbol.description'])));
});

test('checkAccessors rejects a property that ACCESSORS does not name', () => {
  const data = {
    javascript: {
      builtins: {
        Error: { message: { __compat: { spec_url: 'https://tc39.es/#sec-error.prototype.message', support: {} } } },
      },
    },
  };
  const declarations = ['interface Error {', '    message: string;', '}'].join('\n');
  assert.throws(() => checkAccessors(data, declarations, new Set()), /javascript\.builtins\.Error\.message/);
});

test('checkAccessors rejects a member of ACCESSORS that TypeScript declares as a method or does not declare', () => {
  const compat = spec => ({ __compat: { spec_url: spec, support: {} } });
  const data = {
    javascript: {
      builtins: {
        Symbol: { description: compat('https://tc39.es/#sec-symbol.prototype.description') },
        Error: { message: compat('https://tc39.es/#sec-error.prototype.message') },
      },
    },
  };
  const declarations = ['interface Symbol {', '    description(): string;', '}'].join('\n');
  const accessors = new Set(['javascript.builtins.Symbol.description', 'javascript.builtins.Error.message']);
  assert.throws(
    () => checkAccessors(data, declarations, accessors),
    error => /Symbol\.description/.test(error.message) && /Error\.message/.test(error.message),
  );
  // A member that BCD does not have is an error too.
  assert.throws(
    () => checkAccessors(data, declarations, new Set(['javascript.builtins.Symbol.missing'])),
    /javascript\.builtins\.Symbol\.missing/,
  );
});

test('collectInterfaceParents reads declarations with CRLF line ends', () => {
  const declarations = ['interface Document extends Node {', '}', 'interface Child extends Parent {}', ''].join('\r\n');
  assert.deepEqual(collectInterfaceParents(declarations, new Set(['api.Document', 'api.Child'])), [
    { name: 'Child', parents: ['Parent'] },
    { name: 'Document', parents: ['Node'] },
  ]);
});

test('collectLibMembers reads declarations with CRLF line ends', () => {
  const declarations = [
    'interface Symbol {',
    '    toString(): string;',
    '    readonly description: string | undefined;',
    '}',
    'interface WeakMap<K extends WeakKey, V> {}',
    '',
  ].join('\r\n');
  const members = collectLibMembers(declarations);
  assert.deepEqual(Object.fromEntries([...members].map(([key, kinds]) => [key, [...kinds]])), {
    'Symbol.toString': ['method'],
    'Symbol.description': ['property'],
  });
});
