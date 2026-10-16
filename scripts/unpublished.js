// Tells the release workflow whether to build and publish: it runs on every push to main, and only a merged PR
// "chore: version packages" brings versions that npm lacks. Prints `unpublished=true` when npm lacks the version of
// any of the three packages, the version, and its npm tag: a version with a prerelease part goes to `next`.
// The workflow asks npm instead of the diff of the push: a release that failed halfway is published by the next push.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['core', 'eslint', 'bundler'];

/** Whether the answer of the registry for a package lists `version`. 404: npm lacks the package. */
export function listsVersion(status, body, version) {
  if (status === 404) {
    return false;
  }
  if (status !== 200) {
    throw new Error(`the registry answered ${status}`);
  }
  return Object.hasOwn(body.versions ?? {}, version);
}

async function isPublished(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${name.replaceAll('/', '%2f')}`, {
    // The short form of the document: the versions without their readmes.
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  return listsVersion(response.status, response.status === 200 ? await response.json() : undefined, version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifests = PACKAGES.map(name =>
    JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8')),
  );
  const { version } = manifests[0];
  const published = await Promise.all(manifests.map(manifest => isPublished(manifest.name, manifest.version)));
  console.log(`unpublished=${version !== '0.0.0' && published.includes(false)}`);
  console.log(`version=${version}`);
  console.log(`tag=${version.includes('-') ? 'next' : 'latest'}`);
}
