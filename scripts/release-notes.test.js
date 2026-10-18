import { test } from 'node:test';
import assert from 'node:assert/strict';

import { notesOf, releaseNotes } from './release-notes.js';

const CHANGELOG = '# @compatgate/core\n\n## 0.1.1\n\n- Fix B.\n\n## 0.1.0\n\n### Minor Changes\n\n- Add A.\n';

test('the notes of a version are its section of the changelog', () => {
  assert.equal(notesOf(CHANGELOG, '0.1.0'), '### Minor Changes\n\n- Add A.');
  assert.equal(notesOf(CHANGELOG, '0.1.1'), '- Fix B.');
});

test('a heading in a block of code does not end the section', () => {
  const changelog = '## 0.2.0\n\nExample:\n\n```md\n## 0.1.0\n```\n\n- After.\n\n## 0.1.0\n\n- Old.\n';
  assert.equal(notesOf(changelog, '0.2.0'), 'Example:\n\n```md\n## 0.1.0\n```\n\n- After.');
});

test('a fence with an info string does not close a block of code', () => {
  const changelog = '## 0.2.0\n\n````md\n```js\n## 0.1.0\n```\n````\n\n## 0.1.0\n\n- Old.\n';
  assert.equal(notesOf(changelog, '0.2.0'), '````md\n```js\n## 0.1.0\n```\n````');
  const tilde = '## 0.2.0\n\n```\n```js\n## 0.1.0\n```\n\n## 0.1.0\n';
  assert.equal(notesOf(tilde, '0.2.0'), '```\n```js\n## 0.1.0\n```');
});

test('a version without a section is an error', () => {
  assert.throws(() => notesOf(CHANGELOG, '0.2.0'), /no section "## 0\.2\.0"/);
});

// The format of `pnpm version -r` 12.9.1 for a package that only follows the core of the same release.
const UPDATED = '- Updated dependencies:\n  - @compatgate/core@0.1.0';

test('the notes of a release join the packages and leave out the updates of their own dependencies', () => {
  const notes = releaseNotes([
    ['@compatgate/core', '### Minor Changes\n\n- Core feature.'],
    ['@compatgate/eslint', `### Patch Changes\n\n${UPDATED}`],
    ['@compatgate/bundler', `### Patch Changes\n\n- Bundler fix.\n\n${UPDATED}`],
  ]);
  assert.equal(
    notes,
    '## @compatgate/core\n\n### Minor Changes\n\n- Core feature.\n\n' +
      '## @compatgate/bundler\n\n### Patch Changes\n\n- Bundler fix.',
  );
});

test('packages with the same section share one heading', () => {
  const section = '### Minor Changes\n\n- The first release.';
  const notes = releaseNotes([
    ['@compatgate/core', section],
    ['@compatgate/eslint', `${section}\n\n${UPDATED}`],
    ['@compatgate/bundler', '### Patch Changes\n\n- Bundler fix.'],
  ]);
  assert.equal(
    notes,
    `## @compatgate/core, @compatgate/eslint\n\n${section}\n\n## @compatgate/bundler\n\n### Patch Changes\n\n- Bundler fix.`,
  );
});

test('the notes keep the indent of a block of code in an item', () => {
  const section = '### Minor Changes\n\n- Set it up:\n\n  ```js\n  a();\n\n  b();\n  ```';
  assert.equal(releaseNotes([['@compatgate/core', section]]), `## @compatgate/core\n\n${section}`);
});

test('the notes keep the blank lines of a block of code', () => {
  const section = '### Minor Changes\n\n- Set it up:\n\n  ```js\n  a();\n\n\n  b();\n  ```';
  assert.equal(releaseNotes([['@compatgate/core', section]]), `## @compatgate/core\n\n${section}`);
});

test('a release without a change of its own is an error', () => {
  assert.throws(
    () => releaseNotes([['@compatgate/eslint', `### Patch Changes\n\n${UPDATED}`]]),
    /no changes to describe/,
  );
});
