---
type: Added
---
- **The npm package now carries the licence texts of the packages built into it.** `dist/cli.js` and `dist/index.js` have their JavaScript dependencies built in, and the package shipped none of those licence texts. The server build now writes `dist/THIRD-PARTY-LICENSES.txt`: the project's LICENSE and NOTICE, then the licence text of every package built into those files. The Docker image ships the same `dist`, so it carries the file too. The build stops if a built-in package has no licence text, and the install smoke checks the file is in the tarball npm would publish.
