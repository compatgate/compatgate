import { rspack } from '@rspack/core';
import { compatgateRspack } from '@compatgate/bundler';

const compiler = rspack({
  mode: 'none',
  context: import.meta.dirname,
  entry: './src/index.js',
  output: { path: `${import.meta.dirname}/dist` },
  plugins: [compatgateRspack()],
});
compiler.run((error, stats) => {
  const messages = stats?.toJson({ all: false, errors: true }).errors?.map(item => item.message) ?? [];
  console.log(messages.join('\n'));
  compiler.close(() => process.exit(error ? 2 : 0));
});
