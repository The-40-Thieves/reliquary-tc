// The `search_mentions` tool behind the OpenAI `openai/mentions` extension (MCP extensions spec
// node-v0.2.1): the host calls it on each keystroke of the @-mention picker with `{ query }` (may be
// empty) and shows the returned resource links. Read-only, markdown notes only, ranked by file name
// then path, then most recently modified. Every candidate passes the caller's read ACL, Obsidian's
// Excluded files and the vault-root confinement, the same gates fetch applies, so a mention is
// always something read_note will return. The host sends no `vault`: an omitted one searches every
// vault resources/list would serve this caller (all of them for a trusted unbound caller, its own for
// a bound one), each under its own ACL, so a link is always one resources/read will open.
import { VaultId } from "@the-40-thieves/reliquary-tc-shared";
import { z } from "zod";
import { SEARCH_MENTIONS_TOOL } from "../../mcp/openai-extension-names";
import type { CallerContext, ToolDefinition } from "../../mcp/registry";
import { buildResourceUri, servesForeignVaults, type VaultAclResolver } from "../../mcp/resources";
import { vaultExclusionFor } from "../../search/index-exclusion";
import { enforcePathAcl } from "../../vault/acl-path";
import { readableEntry, readableRel } from "../../vault/acl-read-filter";
import { noteExists } from "../../vault/notes-io";
import { normalizeVaultPath, resolveVaultPath, walkVault } from "../../vault/paths";
import { readableStoredRow } from "../../vault/stored-acl-path";
import { defineTool } from "../m1/define";
import type { M2Deps } from "./shared";

const MAX_QUERY_CHARS = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export const SearchMentionsInput = z
  .object({
    vault: VaultId.optional().describe("Vault id. Omit to search every vault you can read."),
    query: z.string().max(MAX_QUERY_CHARS),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

const ResourceLink = z.object({
  type: z.literal("resource_link"),
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  mimeType: z.string().optional(),
});

export const SearchMentionsOutput = z.object({ items: z.array(ResourceLink) });

/** What the tool needs from the server: the vault registry, and the metadata-index readiness that
 *  picks the notes table over a disk walk (absent in tests: the walk). */
export type SearchMentionsDeps = Pick<M2Deps, "vaultRegistry" | "metadataIndex">;

interface SearchedVault {
  id: string;
  root: string;
  acl: CallerContext["acl"];
}

interface Candidate {
  vault: SearchedVault;
  rel: string;
  mtime: number;
  rank: number;
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf("/") + 1);

/** A file name without its `.md` suffix (the mention's displayed name). */
function stripMd(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name.slice(0, -3) : name;
}

/** 0 when the query is in the file name, 1 when only in the rest of the path, null otherwise. */
function rankOf(rel: string, query: string): number | null {
  if (stripMd(baseName(rel)).toLowerCase().includes(query)) return 0;
  if (rel.toLowerCase().includes(query)) return 1;
  return null;
}

/** Readable, non-excluded markdown notes from the notes table (rows judged on their ACL identity). */
function candidatesFromIndex(
  deps: SearchMentionsDeps,
  ctx: CallerContext,
  vault: SearchedVault,
): Array<{ rel: string; mtime: number }> {
  const excluded = vaultExclusionFor(deps.vaultRegistry, vault.id);
  const readable = readableStoredRow(ctx.db, vault.id, (acl) =>
    readableRel(vault.acl, acl, ctx.grantedScopes),
  );
  const rows = ctx.db
    .prepare("SELECT path, mtime FROM notes WHERE vault_id = ?")
    .all(vault.id) as Array<{ path: string; mtime: number }>;
  return rows
    .filter(
      (r) =>
        r.path.toLowerCase().endsWith(".md") && !excluded.isExcluded(r.path) && readable(r.path),
    )
    .map((r) => ({ rel: r.path, mtime: r.mtime }));
}

/** Readable, non-excluded markdown notes from a disk walk (the list_notes listing). */
function candidatesFromDisk(
  deps: SearchMentionsDeps,
  ctx: CallerContext,
  vault: SearchedVault,
): Array<{ rel: string; mtime: number }> {
  const excluded = vaultExclusionFor(deps.vaultRegistry, vault.id);
  return walkVault(vault.root, { extensions: [".md"] })
    .filter(
      (e) => readableEntry(vault.acl, e, ctx.grantedScopes) && !excluded.isExcluded(e.relPath),
    )
    .map((e) => ({ rel: e.relPath, mtime: e.mtime }));
}

/** The vaults one call searches: the named one, or every vault resources/list serves this caller. */
function searchedVaults(
  deps: SearchMentionsDeps,
  ctx: CallerContext,
  aclFor: VaultAclResolver,
  named: string | undefined,
): SearchedVault[] {
  const reg = deps.vaultRegistry;
  const vaults =
    named !== undefined
      ? [reg.resolve(named)]
      : servesForeignVaults(ctx, reg)
        ? reg.list()
        : [reg.resolve(ctx.vaultId)];
  return vaults.map((v) => ({ id: v.id, root: v.root, acl: aclFor(v.id) ?? ctx.acl }));
}

export function buildSearchMentionsTool(
  deps: SearchMentionsDeps,
  aclFor: VaultAclResolver,
): ToolDefinition {
  return defineTool({
    name: SEARCH_MENTIONS_TOOL,
    domain: "search",
    appVisible: true,
    description:
      'Search note names and paths for the @-mention picker. Returns {items: [{type: "resource_link", uri, name, title, mimeType}]}: one item per note, best match first (file name matches before path matches), then most recently modified. An empty query returns the most recently modified notes. Each uri reads with the note\'s full text.',
    inputSchema: SearchMentionsInput,
    outputSchema: SearchMentionsOutput,
    requiredScopes: ["read:notes"],
    handler: (input, ctx: CallerContext) => {
      const query = input.query.toLowerCase();
      const indexed = deps.metadataIndex?.ready() === true;
      const ranked: Candidate[] = [];
      for (const vault of searchedVaults(deps, ctx, aclFor, input.vault)) {
        const pool = indexed
          ? candidatesFromIndex(deps, ctx, vault)
          : candidatesFromDisk(deps, ctx, vault);
        for (const c of pool) {
          const rank = rankOf(c.rel, query);
          if (rank !== null) ranked.push({ ...c, vault, rank });
        }
      }
      ranked.sort(
        (a, b) =>
          a.rank - b.rank ||
          b.mtime - a.mtime ||
          a.rel.localeCompare(b.rel) ||
          a.vault.id.localeCompare(b.vault.id),
      );
      const items: z.infer<typeof ResourceLink>[] = [];
      for (const c of ranked) {
        if (items.length >= input.limit) break;
        try {
          // Fail closed: a row the canonical-path check refuses, that escapes the vault root, or
          // that vanished since it was indexed is dropped, never offered.
          const rel = normalizeVaultPath(c.rel);
          enforcePathAcl(c.vault.acl, "read", rel, c.vault.root, ctx.grantedScopes);
          const ex = noteExists(resolveVaultPath(c.vault.root, rel));
          if (!ex.exists || ex.type === "folder") continue;
          items.push({
            type: "resource_link",
            uri: buildResourceUri(c.vault.id, rel),
            name: stripMd(baseName(rel)),
            title: rel,
            mimeType: "text/markdown",
          });
        } catch {
          // dropped
        }
      }
      return { items };
    },
  });
}
