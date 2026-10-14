// The probe bundle of the analysis: what a real bundle used beyond the targets.
// Findings: lookbehind, the `v` flag, `Intl.Segmenter`, `structuredClone`, `Object.groupBy`, `toSorted`,
// a class static block (Safari 16.4) and a public instance field (partial: Safari 14.1–15.6, bug 236843).
// No findings: static and private fields, `.at()`, `??=`.

export const price = /(?<=\$)\d+/;
export const letters = /[\p{L}--\p{N}]/v;
export const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
export const copy = structuredClone({ a: 1 });
export const groups = Object.groupBy([1, 2, 3], n => (n % 2 ? 'odd' : 'even'));
export const sorted = list => list.toSorted();

export class Registry {
  static defaultName = 'registry';
  static #count = 0;
  #items = [];
  name = Registry.defaultName;

  static {
    Registry.#count += 1;
  }

  add(item) {
    this.#items ??= [];
    this.#items.push(item);
  }

  last() {
    return this.#items.at(-1);
  }
}
