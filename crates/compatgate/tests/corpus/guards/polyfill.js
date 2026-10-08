// a_polyfill_is_not_a_use. The assignment declares `toSorted` for the whole file, so the snippet has
// its own file.
if (!Array.prototype.toSorted) { Array.prototype.toSorted = function () {}; } //~ none
