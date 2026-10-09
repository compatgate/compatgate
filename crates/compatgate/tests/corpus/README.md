# Corpus

Snippets of JavaScript and TypeScript with the findings that `check` must give for them. `tests/corpus.rs`
checks every file here. Other tools that wrap the core can read the same files.

## Format

A file is one program: `check` reads it whole, with its extension (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`
and the others that oxc knows).

The header of a file, the comment lines at its start, sets the arguments of `check`:

```js
// targets: Chrome >= 50
// filename: /project/node_modules/x/index.js
// allow: ["api.structuredClone", {"feature": "api.Navigator.share", "packages": ["x"]}]
```

- `// targets:` is the browserslist query. Without it the query is
  `Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115`.
- `// filename:` is the filename that `check` gets. Without it the filename is the path of the file in the
  corpus, such as `guards/model.js`. The extension of the corpus file must still be one that `check`
  parses, so that the test finds the file.
- `// allow:` is a JSON array of `allow` entries. A string is a feature id. An object has the fields of an
  entry of the binding: `feature`, `packages`, `files` and `baseDir`. Without `baseDir` the globs in
  `files` are relative to the directory of the filename. Without the directive the list is empty.

Lines end as `check` counts them: at `\n`, `\r\n`, a lone `\r`, U+2028 and U+2029. A line comment
ends there too.

A comment `//~` at the end of a line lists the findings that start on that line:

```js
navigator.share(d); //~ api.Navigator.share exact
if (navigator.share) navigator.share(d); //~ none
arr.toSorted(); new Intl.Segmenter(); //~ javascript.builtins.Array.toSorted heuristic; javascript.builtins.Intl.Segmenter exact
while (navigator.share) { navigator.share(d); } //~ @8 api.Navigator.share exact; @27 api.Navigator.share exact
```

- One finding is `<feature> <confidence>`: the BCD key and `exact`, `heuristic` or `partial`.
- Findings are separated by `;` and ordered by column, then by feature.
- `none` means no findings on the line.
- `@<column>` comes first when the line has more than one finding of the same feature. The column counts
  from 1 in UTF-16 units, as in ESLint.
- An expectation has no end column. The end of a finding is the end of the node that the detector reports,
  and the start and the feature already pick that node: a detector reports a feature once per node, and
  no two findings of the corpus share the feature and the start. The end becomes a line and a column by
  the same code as the start, and `tests/check.rs` checks the end of a finding.
- A finding on a line without `//~` fails the run too, so every line with findings carries `//~`.
  A line without findings may leave it out.
- An expectation is a line comment that starts with `//~`. `//~` in a string, a template literal, JSX text
  or inside another comment does not count.

`BLESS=1 cargo test -p compatgate --test corpus` rewrites every `//~` comment with the current findings
and adds one to a line with findings that has none. It fails instead of adding one where the line ends
inside a template literal, a block comment or JSX text: move the code so that the finding starts on
another line.
Review the diff before you commit it.

## Rules for snippets

- Snippets of one file share the scope and the file-wide state. A snippet that declares a name sits in
  a block `{ … }` or in a function, so it does not change the other snippets. A snippet that exits early
  sits in a function: the facts of an early exit hold after the block that holds it.
- A snippet that declares a member name (`class Q { union() {} }`, `{ take: f }`, `api.take = f`)
  stops method findings of that name in the whole file. Such a snippet gets its own file.
- So does a snippet with `import`, a top-level `var` or `function` that other snippets of the file
  refer to, or another header: targets, a filename or `allow` entries.
- A file must be a valid program: the test fails on a name declared twice and on other syntax errors.
