import { createRequire } from 'node:module';

import { exact, heuristic, partial, type RuleModule } from './rule.ts';

export { OptionsError } from '@compatgate/core';
export type { RuleContext, RuleModule } from './rule.ts';
export type { CompatgateSettings } from './settings.ts';

// The version of the package itself: `dist/index.js` and `src/index.ts` both lie one level below package.json.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

export interface CompatgatePlugin {
  meta: { name: string; version: string };
  rules: { exact: RuleModule; heuristic: RuleModule; partial: RuleModule };
  configs: { recommended: RecommendedConfig };
}

/** A flat config of ESLint. oxlint takes the rules from `.oxlintrc.json` instead. */
export interface RecommendedConfig {
  name: string;
  plugins: { compatgate: CompatgatePlugin };
  rules: {
    'compatgate/exact': 'error';
    'compatgate/heuristic': 'warn';
    'compatgate/partial': 'warn';
  };
}

const recommended: RecommendedConfig = {
  name: '@compatgate/eslint/recommended',
  // Set below: the config and the plugin refer to each other.
  plugins: {} as RecommendedConfig['plugins'],
  rules: {
    'compatgate/exact': 'error',
    'compatgate/heuristic': 'warn',
    'compatgate/partial': 'warn',
  },
};

// oxlint takes the plugin name from `meta.name` and names the rules `@compatgate/eslint/exact` and so on.
const plugin: CompatgatePlugin = {
  meta: { name: '@compatgate/eslint', version },
  rules: { exact, heuristic, partial },
  configs: { recommended },
};
recommended.plugins.compatgate = plugin;

export default plugin;
