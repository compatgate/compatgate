// Feature checks in code. Each guarded use is no finding; the uses at the end are.

const data = { title: 'compatgate' };

// typeof, truthiness, `in` and comparisons.
if (typeof structuredClone === 'function') structuredClone(data);
if (navigator.share) navigator.share(data);
if ('share' in navigator) navigator.share(data);
if (window.structuredClone !== undefined) structuredClone(data);
if (navigator.userActivation != null) console.log(navigator.userActivation.isActive);

// The branches of `?:`, `&&` and `||`.
export const copy = typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data));
export const shared = navigator.share && navigator.share(data);
export const skipped = !navigator.share || navigator.share(data);

// An early exit, and the `else` branch of a negative check.
export function share() {
  if (!navigator.share) {
    return;
  }
  navigator.share(data);
}
if (!('Segmenter' in Intl)) {
  console.log('no segmenter');
} else {
  console.log(new Intl.Segmenter());
}

// Optional chaining and a value after `||` or `??`: the author expects it to be missing.
navigator.share?.(data);
export const clone = window.structuredClone || (value => value);
export const shareOrNothing = navigator.share ?? null;

// An alias of the feature, checked.
const shareData = navigator.share;
if (shareData) shareData.call(navigator, data);

// A `try` in the same function.
try {
  console.log(new Intl.Segmenter());
} catch {
  console.log('no segmenter');
}

// The condition of a loop holds in its body.
while (navigator.share) {
  navigator.share(data);
  break;
}

// A check of the root of a chain: `navigation.currentEntry` needs `navigation` too.
if (window.navigation) console.log(navigation.currentEntry);

// A check of another feature that every target without `Intl.Segmenter` lacks too: Firefox 115 has no
// `navigator.share`, so the check implies `Intl.Segmenter`.
if (navigator.share) console.log(new Intl.Segmenter());

// Findings: no check, a check of another feature that Firefox 115 has, and a bare value that goes on: passed,
// returned or stored.
structuredClone(data);
if (window.structuredClone) console.log(new Intl.Segmenter());
console.log(navigator.share);
export function getShare() {
  return navigator.share;
}
export const handlers = {};
handlers.share = navigator.share;
