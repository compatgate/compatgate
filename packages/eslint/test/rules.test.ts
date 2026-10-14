import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester } from 'eslint';

import { clearCaches } from '@compatgate/core';
import plugin from '../src/index.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
after(() => clearCaches());

const TARGETS = 'Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115';
const settings = (extra: Record<string, unknown> = {}) => ({ compatgate: { targets: TARGETS, allow: [], ...extra } });

const tester = new RuleTester({ settings: settings() });

const STRUCTURED_CLONE =
  'api.structuredClone is not supported in Chrome 97 (since 98). ' +
  'Check the feature in code, or add "api.structuredClone" to settings.compatgate.allow.';
const LOOKBEHIND =
  'javascript.regular_expressions.lookbehind_assertion is not supported in Safari 15.6 (since 16.4), ' +
  'Safari on iOS 15.5 (since 16.4). Lower the syntax with the transpiler, ' +
  'or add "javascript.regular_expressions.lookbehind_assertion" to settings.compatgate.allow.';
const TO_SORTED =
  'javascript.builtins.Array.toSorted is not supported in Chrome 97 (since 110), Safari 15.6 (since 16), ' +
  'Safari on iOS 15.5 (since 16). The method is found by its name, so it may also be ' +
  'javascript.builtins.TypedArray.toSorted. ' +
  'Check the feature in code, or add "javascript.builtins.Array.toSorted" to settings.compatgate.allow.';
const BARCODE =
  'api.BarcodeDetector.BarcodeDetector is only partially supported in Chrome 97 (no full support in any version). ' +
  'Chrome 97: Supported on ChromeOS and macOS only. ' +
  'If the limits do not affect this code, add "api.BarcodeDetector.BarcodeDetector" to settings.compatgate.allow.';
const CLASS_FIELDS =
  'javascript.classes.public_class_fields is only partially supported in Safari 15.6 (full support since 16), ' +
  'Safari on iOS 15.5 (full support since 16). Safari 15.6, Safari on iOS 15.5: Parentheses in field ' +
  'initializers can lead to ReferenceErrors. See bug 236843. ' +
  'If the limits do not affect this code, add "javascript.classes.public_class_fields" to settings.compatgate.allow.';

tester.run('exact', plugin.rules.exact, {
  valid: [
    // A feature check protects the call.
    "if (typeof structuredClone === 'function') structuredClone(1);",
    // An allow entry as a feature id.
    { code: 'structuredClone(1);', settings: settings({ allow: ['api.structuredClone'] }) },
    // Other confidences belong to other rules.
    'x.toSorted();',
    // Syntax is off by default.
    'const r = /(?<=a)b/;',
    // A finding of a feature that the targets support.
    'const a = [1].at(-1);',
  ],
  invalid: [
    {
      code: 'structuredClone(1);',
      errors: [{ message: STRUCTURED_CLONE, line: 1, column: 1, endLine: 1, endColumn: 16 }],
    },
    {
      code: 'const r = /(?<=a)b/;',
      settings: settings({ syntax: true }),
      errors: [{ message: LOOKBEHIND, line: 1, column: 12, endLine: 1, endColumn: 16 }],
    },
    {
      code: 'const r = /(?<=a)b/; structuredClone(1);',
      settings: settings({ syntax: false }),
      errors: [{ message: STRUCTURED_CLONE, column: 22 }],
    },
  ],
});

tester.run('heuristic', plugin.rules.heuristic, {
  valid: [
    'structuredClone(1);',
    { code: 'x.toSorted();', settings: settings({ allow: ['javascript.builtins.TypedArray.toSorted'] }) },
  ],
  invalid: [{ code: 'x.toSorted();', errors: [{ message: TO_SORTED, line: 1, column: 3, endColumn: 11 }] }],
});

tester.run('partial', plugin.rules.partial, {
  valid: [
    {
      code: 'new BarcodeDetector();',
      settings: settings({ targets: 'Chrome >= 97', allow: ['api.BarcodeDetector.BarcodeDetector'] }),
    },
    // The partial finding of class fields is syntax: off by default.
    'class A { x = 1; }',
  ],
  invalid: [
    {
      code: 'new BarcodeDetector();',
      settings: settings({ targets: 'Chrome >= 97' }),
      errors: [{ message: BARCODE, line: 1, column: 5, endColumn: 20 }],
    },
    {
      code: 'class A { x = 1; }',
      settings: settings({ syntax: true }),
      errors: [{ message: CLASS_FIELDS, column: 11 }],
    },
  ],
});

describe('the form of the rules', () => {
  it('reports in create and returns no visitor, so oxlint does not build the AST in JavaScript', () => {
    const reports: unknown[] = [];
    const visitor = plugin.rules.exact.create({
      filename: '/p/a.js',
      physicalFilename: '/p/a.js',
      cwd: '/p',
      settings: settings(),
      sourceCode: { text: 'structuredClone(1);' },
      report: descriptor => reports.push(descriptor),
    });
    assert.deepEqual(visitor, {});
    assert.deepEqual(reports, [
      { loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 15 } }, message: STRUCTURED_CLONE },
    ]);
  });
});
