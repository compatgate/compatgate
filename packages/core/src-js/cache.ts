/** A map that keeps the `size` most recently used keys. */
export class LruCache<K, V> {
  readonly #size: number;
  // A `Map` iterates in insertion order, so the first key is the least recently used one.
  readonly #entries = new Map<K, V>();

  constructor(size: number) {
    this.#size = size;
  }

  get(key: K, create: () => V): V {
    if (this.#entries.has(key)) {
      const value = this.#entries.get(key) as V;
      this.#entries.delete(key);
      this.#entries.set(key, value);
      return value;
    }
    const value = create();
    if (this.#entries.size >= this.#size) {
      this.#entries.delete(this.#entries.keys().next().value as K);
    }
    this.#entries.set(key, value);
    return value;
  }

  get size(): number {
    return this.#entries.size;
  }

  values(): IterableIterator<V> {
    return this.#entries.values();
  }

  clear(): void {
    this.#entries.clear();
  }
}
