import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeFinding } from '../src-js/describe.ts';
import type { CoreFinding as Finding, Gap } from '../src-js/types.ts';
import { check } from './resolve.ts';

function finding(feature: string, fields: Partial<Finding> & { unsupported: Gap[] }): Finding {
  return {
    feature,
    kind: 'builtin',
    confidence: 'exact',
    alternatives: [],
    start: { line: 1, column: 0 },
    end: { line: 1, column: 1 },
    range: [0, 1],
    ...fields,
  };
}

test('an exact finding names each browser by its human name with the version of support', () => {
  const message = describeFinding(
    finding('javascript.builtins.Intl.Segmenter', {
      unsupported: [
        { browser: 'safari', target: '15.6', since: '16.4' },
        { browser: 'safari_ios', target: '15.5', since: '16.4' },
      ],
    }),
  );
  assert.equal(
    message,
    'javascript.builtins.Intl.Segmenter is not supported in Safari 15.6 (since 16.4), Safari on iOS 15.5 (since 16.4). ' +
      'Check the feature in code, or add "javascript.builtins.Intl.Segmenter" to compatgate.jsonc.',
  );
});

test('the advice names the place of the allow entries of the project', () => {
  const segmenter = finding('javascript.builtins.Intl.Segmenter', {
    unsupported: [{ browser: 'firefox', target: '115', since: '125' }],
  });
  const advice = (options?: Parameters<typeof describeFinding>[1]) =>
    describeFinding(segmenter, options).replace(/^.*, or /, '');
  assert.equal(advice(), 'add "javascript.builtins.Intl.Segmenter" to compatgate.jsonc.');
  // A path inside the project root is relative to it; another path stays absolute.
  assert.equal(
    advice({ allowIn: '/p/src/lib/compatgate.jsonc', baseDir: '/p' }),
    'add "javascript.builtins.Intl.Segmenter" to src/lib/compatgate.jsonc.',
  );
  assert.equal(
    advice({ allowIn: '/q/compatgate.jsonc', baseDir: '/p' }),
    'add "javascript.builtins.Intl.Segmenter" to /q/compatgate.jsonc.',
  );
  // An option is named as it is.
  assert.equal(
    advice({ allowIn: 'settings.compatgate.allow', baseDir: '/p' }),
    'add "javascript.builtins.Intl.Segmenter" to settings.compatgate.allow.',
  );
});

test('a browser without a version of support says so', () => {
  const message = describeFinding(
    finding('api.Navigator.share', {
      kind: 'api',
      unsupported: [{ browser: 'firefox', target: '115' }],
    }),
  );
  assert.equal(
    message,
    'api.Navigator.share is not supported in Firefox 115 (no support in any version). ' +
      'Check the feature in code, or add "api.Navigator.share" to compatgate.jsonc.',
  );
});

test('a partial finding gives the BCD note once for the browsers that share it', () => {
  const note = 'Parentheses in field initializers can lead to ReferenceErrors. See bug 236843.';
  const message = describeFinding(
    finding('javascript.classes.public_class_fields', {
      kind: 'syntax',
      confidence: 'partial',
      unsupported: [
        { browser: 'safari', target: '15.6', since: '16', note },
        { browser: 'safari_ios', target: '15.5', since: '16', note },
        { browser: 'chrome', target: '97', note: 'Supported on macOS only' },
      ],
    }),
  );
  assert.equal(
    message,
    'javascript.classes.public_class_fields is only partially supported in ' +
      'Safari 15.6 (full support since 16), Safari on iOS 15.5 (full support since 16), ' +
      'Chrome 97 (no full support in any version). ' +
      `Safari 15.6, Safari on iOS 15.5: ${note} Chrome 97: Supported on macOS only. ` +
      'If the limits do not affect this code, add "javascript.classes.public_class_fields" to compatgate.jsonc.',
  );
});

test('a heuristic finding names its alternatives', () => {
  const message = describeFinding(
    finding('javascript.builtins.Array.toSorted', {
      confidence: 'heuristic',
      alternatives: ['javascript.builtins.TypedArray.toSorted'],
      unsupported: [
        { browser: 'chrome', target: '97', since: '110' },
        { browser: 'safari', target: '15.6', since: '16' },
      ],
    }),
  );
  assert.equal(
    message,
    'javascript.builtins.Array.toSorted is not supported in Chrome 97 (since 110), Safari 15.6 (since 16). ' +
      'The method is found by its name, so it may also be javascript.builtins.TypedArray.toSorted. ' +
      'Check the feature in code, or add "javascript.builtins.Array.toSorted" to compatgate.jsonc.',
  );
});

test('a heuristic finding without alternatives says that the type is unknown', () => {
  const message = describeFinding(
    finding('javascript.builtins.Array.findLast', {
      confidence: 'heuristic',
      unsupported: [{ browser: 'chrome_android', target: '90', since: '97' }],
    }),
  );
  assert.match(
    message,
    /in Chrome Android 90 \(since 97\)\. The method is found by its name: the type of the object is unknown\. /,
  );
});

test('a syntax finding suggests the transpiler instead of a check in code', () => {
  const message = describeFinding(
    finding('javascript.regular_expressions.lookbehind_assertion', {
      kind: 'syntax',
      unsupported: [{ browser: 'safari', target: '15.6', since: '16.4' }],
    }),
  );
  assert.equal(
    message,
    'javascript.regular_expressions.lookbehind_assertion is not supported in Safari 15.6 (since 16.4). ' +
      'Lower the syntax with the transpiler, or add "javascript.regular_expressions.lookbehind_assertion" to compatgate.jsonc.',
  );
});

test('every browser of the core has a human name', () => {
  // No browser supports EyeDropper at these targets, so the finding lists every browser of the core.
  // browserslist knows only the latest version of Chrome and Firefox for Android.
  const query =
    'Chrome 80, and_chr >= 1, Edge 80, Firefox 80, and_ff >= 1, Opera 60, op_mob >= 1, ' +
    'Safari 13, iOS 13, Samsung 12.0, Android >= 4';
  const [eyeDropper] = check('new EyeDropper();', { filename: 'a.js', targets: query, allow: [] }).findings;
  assert.ok(eyeDropper);
  const browsers = eyeDropper.unsupported.map(gap => gap.browser);
  assert.equal(browsers.length, 11, browsers.join(', '));
  const message = describeFinding(eyeDropper);
  for (const browser of browsers) {
    assert.ok(!message.includes(browser), `${browser} has no human name in: ${message}`);
  }
  const names = [
    'Chrome 80',
    'Chrome Android ',
    'Edge 80',
    'Firefox 80',
    'Firefox for Android ',
    'Opera 60',
    'Opera Android ',
    'Safari 13',
    'Safari on iOS 13',
    'Samsung Browser 12 ',
    'WebView Android 4',
  ];
  for (const name of names) {
    assert.ok(message.includes(name), `${name} is missing in: ${message}`);
  }
});

test('an unknown browser id stays as it is', () => {
  const message = describeFinding(finding('api.a', { unsupported: [{ browser: 'netscape', target: '4' }] }));
  assert.match(message, /in netscape 4 \(no support in any version\)/);
});
