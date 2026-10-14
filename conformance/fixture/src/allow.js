// `allow` entries of compatgate.jsonc.

// A feature id: no finding anywhere.
export const deferred = Promise.withResolvers();

// `Array.fromAsync` is allowed in the files of `pkg-a` only.
export const fromItems = items => Array.fromAsync(items);

// `CompressionStream` is allowed in `src/legacy/**` only.
export const compress = stream => stream.pipeThrough(new CompressionStream('gzip'));

// `extends` of compatgate.jsonc: the base list of the package `compat-base`.
export const wait = buffer => Atomics.waitAsync(buffer, 0, 0);

// The `extends` option of the adapter: `base.jsonc`.
export const pick = () => new EyeDropper().open();
