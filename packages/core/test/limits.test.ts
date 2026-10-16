// Configs come from dependencies too, so the core takes any size of input. An overflow of the native stack ends the
// process past every guard, so each case runs in a process of its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createProject } from '@compatgate/test-utils';

const index = new URL('../src-js/index.ts', import.meta.url).href;

/** Runs `body` with `core` and `root` in a new process and gives the line it prints. */
function run(root: string, body: string): string {
  const script = `
    const core = await import(${JSON.stringify(index)});
    const root = ${JSON.stringify(root)};
    const resolve = options => core.createResolver({ baseDir: root, ...options }).resolve(root + '/a.js');
    try {
      ${body}
    } catch (error) {
      console.log(error.name + ': ' + error.message.slice(0, 200));
    }
  `;
  // The script goes through stdin: with an id of 100 kB it is longer than a command line of Windows.
  const child = spawnSync(process.execPath, ['--input-type=module'], { input: script, encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.signal, null, `ended by ${child.signal}: ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('an allow entry with a deep or a long id is an unknown feature', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 97\n' });
  for (const id of [Array(20_000).fill('a').join('.'), `api.${'a'.repeat(100_000)}`]) {
    const line = run(
      root,
      `const issues = resolve({ allow: [${JSON.stringify(id)}] }).issues;
       console.log(issues.map(issue => issue.kind + ' ' + issue.message.length).join());`,
    );
    // The message names the id in short: the whole id would be a message of 100 kB.
    assert.match(line, /^unknown-feature \d+$/);
    assert.ok(Number(line.split(' ')[1]) < 500, line);
  }
});

test('a long pattern of files, a long query and a long chain of extends end in a result or an error', () => {
  const root = createProject({ '.browserslistrc': 'Chrome >= 97\n' });
  const files = `${'a/'.repeat(20_000)}*.js`;
  assert.doesNotMatch(
    run(root, `resolve({ allow: [{ feature: 'api.fetch', files: ${JSON.stringify(files)} }] }); console.log('ok');`),
    /RangeError/,
  );
  const query = Array(5_000).fill('chrome 97').join(', ');
  assert.equal(run(root, `resolve({ targets: ${JSON.stringify(query)}, allow: [] }); console.log('ok');`), 'ok');
  // A chain of 3 000 configs, each extending the next: the reads of the chain overflowed the stack of JavaScript.
  for (let i = 0; i < 3_000; i += 1) {
    writeFileSync(join(root, `c${i}.jsonc`), i === 2_999 ? '{ "allow": [] }' : `{ "extends": "./c${i + 1}.jsonc" }`);
  }
  writeFileSync(join(root, 'compatgate.jsonc'), '{ "extends": "./c0.jsonc" }');
  assert.match(
    run(root, `resolve({}); console.log('ok');`),
    /^AllowConfigError: .*: "extends" goes deeper than 100 configs$/,
  );
});
