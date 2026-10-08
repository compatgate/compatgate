// filename: /project/node_modules/.pnpm/y@1.0.0/node_modules/x/dist/index.js
// allow: [{"feature": "api.structuredClone", "packages": ["x"]}, {"feature": "api.Navigator.share", "packages": ["y"]}]
// An entry with `packages` suppresses findings in the files of these packages. The last `node_modules`
// segment names the package that holds the file, so it is `x`, not `y`.
structuredClone(v); //~ none
navigator.share(d); //~ api.Navigator.share exact
