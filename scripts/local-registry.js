// A local npm registry with the packages of a release, so that a check installs them by name and version, as a user
// installs them from npmjs.com. npm then picks the platform package of the core through its optionalDependencies, which
// an install of tarballs by path skips. The other packages come from npmjs.com through the registry.
//
// `node scripts/local-registry.js --tarballs <dir>` serves until it is stopped and writes the address to
// `<dir>/registry.json`: a check on another Node version uses the registry that Node 24 runs (verdaccio needs Node 22).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {
      // The server is not listening yet.
    }
    await new Promise(next => setTimeout(next, 200));
  }
  throw new Error(`the local registry does not answer at ${url}`);
}

/**
 * The core as `napi pre-publish` publishes it: with the platform packages of the directory in its optionalDependencies.
 * Gives the path of the new tarball.
 */
function withPlatformPackages(core, platforms, directory) {
  const work = mkdtempSync(join(tmpdir(), 'compatgate-core-'));
  execFileSync('tar', ['-xzf', core, '-C', work]);
  const manifest = join(work, 'package', 'package.json');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  pkg.optionalDependencies = Object.fromEntries(platforms.map(name => [name, pkg.version]));
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
  const out = mkdtempSync(join(directory, '.core-'));
  execFileSync(npm, ['pack', '--ignore-scripts', '--pack-destination', out], {
    cwd: join(work, 'package'),
    stdio: 'ignore',
    shell: windows,
  });
  return join(out, readdirSync(out)[0]);
}

/** Starts the registry and publishes the tarballs of `directory`. Gives its address and a function that stops it. */
export async function startRegistry(directory) {
  const root = mkdtempSync(join(tmpdir(), 'compatgate-registry-'));
  const config = join(root, 'config.yaml');
  copyFileSync(fileURLToPath(new URL('verdaccio.yaml', import.meta.url)), config);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // The package exports no `bin`: its path comes from the directory of its package.json.
  const bin = join(dirname(createRequire(import.meta.url).resolve('verdaccio/package.json')), 'bin', 'verdaccio');
  const server = spawn(process.execPath, [bin, '--config', config, '--listen', `127.0.0.1:${port}`], {
    stdio: 'inherit',
  });
  const stop = () => server.kill();
  try {
    await waitFor(`${url}/-/ping`);
    const user = await fetch(`${url}/-/user/org.couchdb.user:smoke`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke', password: 'smoke-password' }),
    });
    const { token } = await user.json();
    const npmrc = join(root, '.npmrc');
    writeFileSync(npmrc, `registry=${url}/\n//127.0.0.1:${port}/:_authToken=${token}\n`);

    const files = readdirSync(directory).filter(file => file.endsWith('.tgz'));
    const platforms = files.filter(file => /^compatgate-core-[a-z]/.test(file));
    const names = platforms.map(file => `@compatgate/${file.replace(/^compatgate-/, '').replace(/-\d.*$/, '')}`);
    const core = files.find(file => /^compatgate-core-\d/.test(file));
    const others = files.filter(file => /^compatgate-(eslint|bundler)-\d/.test(file));
    if (!core || others.length !== 2) {
      throw new Error(`expected the tarballs of core, eslint and bundler in ${directory}`);
    }
    const publish = path => {
      const run = spawnSync(npm, ['publish', path, '--userconfig', npmrc, '--registry', url, '--ignore-scripts'], {
        encoding: 'utf8',
        shell: windows,
      });
      if (run.status !== 0) {
        throw new Error(`npm publish ${path} failed:\n${run.stdout}${run.stderr}`);
      }
    };
    for (const file of [...platforms, ...others]) {
      publish(resolve(directory, file));
    }
    publish(withPlatformPackages(resolve(directory, core), names, root));
    return { url, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { tarballs: { type: 'string' } } });
  const directory = resolve(values.tarballs ?? '.smoke');
  mkdirSync(directory, { recursive: true });
  const { url, stop } = await startRegistry(directory);
  // verdaccio runs in a child process: it stops with this one.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
  }
  writeFileSync(join(directory, 'registry.json'), JSON.stringify({ url }));
  console.log(`local registry at ${url}`);
}
