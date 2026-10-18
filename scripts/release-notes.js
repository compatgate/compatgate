// Prints the notes of the GitHub Release of a version: the sections of the version from the CHANGELOG.md of the three
// packages, which `pnpm version -r` writes. The packages share one version, so one release describes them all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Lexer } from 'marked';

const PACKAGES = ['core', 'eslint', 'bundler'];

/**
 * The text between `## <version>` and the next heading of level 1 or 2, without the blank lines around. The tokens of
 * a Markdown lexer: a heading inside a block of code is part of the block.
 */
export function notesOf(changelog, version) {
  const tokens = Lexer.lex(changelog);
  const start = tokens.findIndex(token => token.type === 'heading' && token.depth === 2 && token.text === version);
  if (start === -1) {
    throw new Error(`no section "## ${version}"`);
  }
  const rest = tokens.slice(start + 1);
  const end = rest.findIndex(token => token.type === 'heading' && token.depth <= 2);
  return textOf(end === -1 ? rest : rest.slice(0, end));
}

/** The source text of tokens, without the line breaks around: the spaces at the start are the indent of a block. */
function textOf(tokens) {
  return tokens
    .map(token => token.raw)
    .join('')
    .replace(/^\n+/, '')
    .trimEnd();
}

/**
 * The sections of the packages under their names; packages with the same section, such as one intent for all three,
 * share a heading. The item "Updated dependencies" names the packages of the same release, so it goes; a package with
 * nothing else goes too.
 */
export function releaseNotes(sections) {
  // The names of the packages by their text, in the order of the packages.
  const names = new Map();
  for (const [name, section] of sections) {
    const text = withoutDependencyUpdates(section);
    if (text !== '') {
      names.set(text, [...(names.get(text) ?? []), name]);
    }
  }
  if (names.size === 0) {
    throw new Error('no changes to describe: every package only updates its dependencies');
  }
  return [...names].map(([text, packages]) => `## ${packages.join(', ')}\n\n${text}`).join('\n\n');
}

function withoutDependencyUpdates(section) {
  const kept = [];
  for (const token of Lexer.lex(section)) {
    if (token.type === 'list') {
      const items = token.items.filter(item => !item.text.startsWith('Updated dependencies'));
      if (items.length > 0) {
        kept.push({ ...token, raw: items.map(item => item.raw).join('') });
      }
    } else if (token.type !== 'space') {
      kept.push(token);
    }
  }
  // A heading such as "### Patch Changes" with nothing left under it goes as well.
  return kept
    .filter(
      (token, index) => token.type !== 'heading' || (index + 1 < kept.length && kept[index + 1].type !== 'heading'),
    )
    .map(token => textOf([token]))
    .join('\n\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version] = process.argv.slice(2);
  const sections = PACKAGES.map(name => {
    const changelog = readFileSync(new URL(`../packages/${name}/CHANGELOG.md`, import.meta.url), 'utf8');
    return [`@compatgate/${name}`, notesOf(changelog, version)];
  });
  console.log(releaseNotes(sections));
}
