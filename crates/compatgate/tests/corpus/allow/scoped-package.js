// filename: /project/node_modules/@scope/x/index.js
// allow: [{"feature": "api.structuredClone", "packages": ["@scope/x"]}, {"feature": "api.Navigator.share", "packages": ["x"]}]
// The name of a scoped package has two segments.
structuredClone(v); //~ none
navigator.share(d); //~ api.Navigator.share exact
