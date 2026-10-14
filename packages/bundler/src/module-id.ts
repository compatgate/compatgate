import { win32 } from 'node:path';

/** The file of a module and the name that selects the parser of the core. */
export interface ModuleFile {
  /** The id without the query and the hash. `include`, `exclude` and `allow` match it, and messages show it. */
  path: string;
  /**
   * The name that selects the parser, for a component or a module with a language in the query: `path` plus
   * the extension of the language, such as `/src/App.vue.ts`. Absent for a JavaScript or TypeScript file.
   */
  parseAs?: string;
}

/**
 * The scripts that the core parses, by the extension, with the loader of esbuild for each. `isCheckable` of the
 * core takes the same extensions in any case: a test keeps the two equal. The filters of the bundlers come from
 * this table.
 */
export const SCRIPT_LOADERS: Readonly<Record<string, 'js' | 'jsx' | 'ts' | 'tsx'>> = {
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
};

/** The components of the frameworks. At `enforce: 'post'` the plugin of the framework has compiled them to JavaScript. */
export const COMPONENT_EXTENSIONS: readonly string[] = ['.vue', '.svelte', '.astro'];

const alternatives = (extensions: readonly string[]) => extensions.map(extension => extension.slice(1)).join('|');
const SCRIPTS = alternatives(Object.keys(SCRIPT_LOADERS));
const COMPONENT = new RegExp(`\\.(?:${alternatives(COMPONENT_EXTENSIONS)})$`, 'i');

/**
 * A cheap test of the id that keeps the loader of webpack and rspack off styles and assets. A language in the query
 * passes too. The handler decides on the path: `include`, `exclude` and the query of a component.
 */
export const TRANSFORM_FILTER = {
  include: new RegExp(`\\.(?:${SCRIPTS}|${alternatives(COMPONENT_EXTENSIONS)})(?:[?#]|$)|[?&]lang[.=]`, 'i'),
  exclude: /^\0/,
};

/**
 * esbuild runs the transform in its `onLoad`, and the first `onLoad` that gives contents wins. The plugin then loads
 * the scripts only: a component stays for the plugin of its framework.
 */
export const ESBUILD_FILTER = new RegExp(`\\.(?:${SCRIPTS})$`, 'i');

/** Whether the core parses a file with this name: a script by the extension, in any case. */
export function isScript(filename: string): boolean {
  return Object.hasOwn(SCRIPT_LOADERS, win32.extname(filename).toLowerCase());
}

/**
 * Gives the file of a bundler module id, or `null` for a module that the plugin does not check: a style, data,
 * an asset, a virtual module (`\0` or a relative id) or a block of a component in another language.
 */
export function moduleFile(id: string): ModuleFile | null {
  const end = id.search(/[?#]/);
  if (end === -1) {
    return moduleFileOf(id, '');
  }
  return moduleFileOf(id.slice(0, end), id[end] === '#' ? '' : id.slice(end).replace(/#.*$/, ''));
}

/**
 * Like `moduleFile`, for a bundler that gives the path and the query apart, as webpack and rspack do. A `#` of
 * the path then stays in the path. `query` may start with `?`.
 */
export function moduleFileOf(path: string, query: string): ModuleFile | null {
  // `\0` marks a virtual module of Rollup, and a virtual id is no absolute path. win32 takes POSIX paths too.
  if (path.startsWith('\0') || !win32.isAbsolute(path)) {
    return null;
  }
  if (isScript(path)) {
    return { path };
  }
  const params = new URLSearchParams(query.replace(/^\?/, ''));
  // A style block has no script language, and vue-loader may give it no `lang` at all.
  if (params.get('type') === 'style') {
    return null;
  }
  const lang = queryLanguage(params);
  if (lang !== undefined) {
    const parseAs = `${path}.${lang}`;
    return isScript(parseAs) ? { path, parseAs } : null;
  }
  return COMPONENT.test(path) ? { path, parseAs: `${path}.js` } : null;
}

/** `lang.ts` is the form of Vite, `lang=ts` the form of vue-loader. */
function queryLanguage(params: URLSearchParams): string | undefined {
  for (const [key, value] of params) {
    const vite = /^lang\.(\w+)$/.exec(key);
    if (vite) {
      return vite[1];
    }
    if (key === 'lang' && value !== '') {
      return value;
    }
  }
  return undefined;
}
