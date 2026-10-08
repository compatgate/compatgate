// filename: /project/src/legacy/a.js
// allow: [{"feature": "api.structuredClone", "files": ["src/legacy/**"], "baseDir": "/project"}, {"feature": "api.Navigator.share", "files": ["src/other/**"], "baseDir": "/project"}]
// An entry with `files` suppresses findings in the files that its globs match, relative to `baseDir`.
structuredClone(v); //~ none
navigator.share(d); //~ api.Navigator.share exact
