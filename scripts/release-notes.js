// Prints the notes of the GitHub Release of a version: the sections of the version from the CHANGELOG.md of the three
// packages, which `pnpm version -r` writes. The packages share one version, so one release describes them all.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['core', 'eslint', 'bundler'];

/** The text between `## <version>` and the next `## ` heading outside a block of code, without the blank lines around. */
export function notesOf(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.indexOf(`## ${version}`);
  if (start === -1) {
    throw new Error(`no section "## ${version}"`);
  }
  let fence = null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === null && marker !== undefined) {
      fence = marker;
    } else if (fence !== null && line.startsWith(fence)) {
      fence = null;
    } else if (fence === null && line.startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
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
  let skipping = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('- Updated dependencies')) {
      skipping = true;
    } else if (!skipping || (!line.startsWith(' ') && line !== '')) {
      // The nested list of the item and the blank lines after it end at the next line without an indent.
      skipping = false;
      kept.push(line);
    }
  }
  // A heading such as "### Patch Changes" with no items left under it goes as well.
  const blocks = kept
    .join('\n')
    .split(/\n{2,}/)
    // Only the line breaks at the edges: the spaces at the start are the indent of a block of code.
    .map(block => block.replace(/^\n+|\n+$/g, ''))
    .filter(block => block.trim() !== '');
  return blocks
    .filter(
      (block, index) => !block.startsWith('### ') || (index + 1 < blocks.length && !blocks[index + 1].startsWith('#')),
    )
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
