# Corpus

Snippets of JavaScript and TypeScript with the findings that `check` must give for them. `tests/corpus.rs`
checks every file here. Other tools that wrap the core can read the same files.

## Format

A file is one program: `check` reads it whole, with its extension (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`
and the others that oxc knows).

The first line can set the browserslist query:

```js
// targets: Chrome >= 50
```

Without it the query is `Chrome >= 97, iOS >= 15.5, Safari >= 15.6, Firefox >= 115`.

A comment `//~` at the end of a line lists the findings that start on that line:

```js
navigator.share(d); //~ api.Navigator.share exact
if (navigator.share) navigator.share(d); //~ none
[3, 1].toSorted(); new Intl.Segmenter(); //~ javascript.builtins.Array.toSorted heuristic; javascript.builtins.Intl.Segmenter exact
while (navigator.share) { navigator.share(d); } //~ @8 api.Navigator.share exact; @27 api.Navigator.share exact
```

- One finding is `<feature> <confidence>`: the BCD key and `exact`, `heuristic` or `partial`.
- Findings are separated by `;` and ordered by column, then by feature.
- `none` means no findings on the line.
- `@<column>` comes first when the line has more than one finding of the same feature. The column counts
  from 1 in UTF-16 units, as in ESLint.
- A finding on a line without `//~` fails the run too, so every line with findings carries `//~`.
  A line without findings may leave it out.
- The expectation starts at the last `//~` that begins the line or follows whitespace. `'//~'` in a string
  does not count.

`BLESS=1 cargo test -p compatgate --test corpus` rewrites every `//~` comment with the current findings
and adds one to a line with findings that has none.
Review the diff before you commit it.

`// model:` above a snippet gives the result that the planned flow model of guards expects, when it
differs from the current one.

## Rules for snippets

- Snippets of one file share the scope and the file-wide state. A snippet that declares a name or exits
  early sits in a block `{ … }` or in a function, so it does not change the other snippets.
- A snippet that declares a member name (`class Q { union() {} }`, `{ take: f }`, `api.take = f`)
  stops method findings of that name in the whole file. Such a snippet gets its own file.
- So does a snippet with `import`, a top-level `var` or `function` that other snippets of the file
  refer to, or other targets.
- A file must be a valid program: the test fails on a name declared twice and on other syntax errors.
