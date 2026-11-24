// The sqlite-vec platform package each bun --compile target embeds. Mirrors sqlite-vec's own
// platformPackageName()/extensionSuffix() (index.cjs): the 5 packages it actually publishes. An
// explicit table (not derived) so an unsupported target fails loudly rather than resolving to
// nothing. Shared by scripts/gen-embedded-vec.mjs, which embeds the binary, and
// scripts/lib/binary-license-file.mjs, which names it in the licence file beside the executable.
export const SQLITE_VEC_TARGETS = {
  "bun-linux-x64": { pkg: "sqlite-vec-linux-x64", ext: "so" },
  "bun-linux-arm64": { pkg: "sqlite-vec-linux-arm64", ext: "so" },
  "bun-darwin-x64": { pkg: "sqlite-vec-darwin-x64", ext: "dylib" },
  "bun-darwin-arm64": { pkg: "sqlite-vec-darwin-arm64", ext: "dylib" },
  "bun-windows-x64": { pkg: "sqlite-vec-windows-x64", ext: "dll" },
};
