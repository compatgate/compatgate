// Waits until npm serves packages to an install. npm takes a tarball before its scan of the tarball ends, and an
// install fails until then: the core must not reach npm before its platform packages can be installed, and the check
// of the install must not start before the packages.

/**
 * Asks npm for the missing packages until it serves all of them, `attempts` times at most. An error of the registry,
 * such as 429 or 503, counts as a package not served yet: the platform packages are on npm by then, and a failed
 * wait needs a new approval of the publish.
 */
export async function waitForPackages(packages, { isPublished, sleep, attempts }) {
  let missing = packages;
  let lastError;
  for (let attempt = 1; ; attempt += 1) {
    const served = await Promise.all(
      missing.map(({ name, version }) =>
        isPublished(name, version).catch(error => {
          lastError = error;
          return false;
        }),
      ),
    );
    missing = missing.filter((_, index) => !served[index]);
    if (missing.length === 0) {
      return;
    }
    const names = missing.map(({ name, version }) => `${name}@${version}`).join(', ');
    if (attempt === attempts) {
      const cause = lastError === undefined ? '' : `; the last error: ${lastError.message}`;
      throw new Error(`npm does not serve ${names} after ${attempts} attempts${cause}`);
    }
    console.log(`waiting for ${names}`);
    await sleep();
  }
}
