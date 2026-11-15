---
type: Fixed
---
- **The docs no longer call the local embedder bundled on npm.** The README, the first-run and
  install pages, the embeddings page and `docs/EVALUATION.md` now say the same thing: an npm
  install leaves the embedder out and the server prints the install command, while the Docker
  image, the `.mcpb` bundle and the standalone binaries carry it. The install page's Docker section
  said the image could not resolve the embedder; it can. Refs #1524.
