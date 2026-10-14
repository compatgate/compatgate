// `files` of an allow entry: `CompressionStream` is allowed here.
export const compress = stream => stream.pipeThrough(new CompressionStream('gzip'));
