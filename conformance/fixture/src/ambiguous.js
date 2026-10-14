// Methods found by their name on an object of unknown type.

// `map` is a member of `Array` that every target supports: no finding.
export const doubled = list => list.map(item => item * 2);
// `toSorted` may be `Array` or a typed array: a heuristic finding.
export const sorted = list => list.toSorted();
