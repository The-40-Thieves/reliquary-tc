# Licence texts for packages that publish none

The licence file beside each standalone binary is built from the packages the bundler put into
it (`scripts/lib/third-party-licenses.mjs`). Most packages carry their own `LICENSE`; the build
reads it from the installed package. The files here cover the few that do not, so the build has a
text to ship. Each is a copy of the licence in the project's own repository.

| file | covers | copied from |
|---|---|---|
| `@redis__client.txt` | `@redis/client` | `LICENSE` in `redis/node-redis`, tag `redis@6.3.0` |
| `onnxruntime.txt` | `onnxruntime-common`, `onnxruntime-node`, `onnxruntime-web` | `packages/embedder-local/licenses/onnxruntime-LICENSE` in this repository (`LICENSE` in `microsoft/onnxruntime`) |
| `sqlite-vec.txt` | the `sqlite-vec-<platform>` library embedded in a binary | `LICENSE-MIT` and `LICENSE-APACHE` in `asg017/sqlite-vec`, tag `v0.1.9` |
| `sharp-libvips.txt` | `@img/sharp-libvips-<platform>`, the prebuilt libvips in the Docker image | `THIRD-PARTY-NOTICES.md` in `lovell/sharp-libvips`, tag `v1.3.4`, then `lgpl-3.0.txt` and `gpl-3.0.txt` from `www.gnu.org/licenses` |
| `guid-typescript.txt` | `guid-typescript` | Nowhere: neither the package nor `NicolasDeveloper/guid-typescript` has a licence file. The standard ISC text, for the `"license": "ISC"` and `"author"` its `package.json` declares |

A file is named after its package, with `/` written as `__`. One file may cover several packages
through the alias table in `scripts/lib/binary-license-file.mjs` (and, for the Docker image, the
one in `scripts/lib/image-license-file.mjs`).

## When the build asks for a file here

`bun scripts/build-binary.ts` fails with `<package> ships no licence text` when a newly bundled
package has none. Copy the licence from that package's repository at the version being bundled,
add it here under the name the error gives, and add a row above.

When a package starts shipping its own text, the build fails with `remove the override`. Delete
the file and its row.

A dependency bump does not need a new copy unless the upstream licence changed. Check it when
the package's major version changes.
