// The OpenAI MCP extensions this server advertises (node-v0.2.1): `openai/mentions` names the
// search tool a ChatGPT @-mention picker calls per keystroke. Everything here is behind
// `toolFacade.openaiMentions` (default off): with the flag off these helpers return nothing, so the
// capabilities and every tools/list surface are unchanged.
import type { Tool } from "@modelcontextprotocol/server";
import { domainTools } from "./facade";
import { OPENAI_MENTIONS_EXTENSION, SEARCH_MENTIONS_TOOL } from "./openai-extension-names";
import type { ToolRegistry } from "./registry";
import { TASKS_EXTENSION } from "./tasks";
import { projectTool } from "./tool-projection";
import type { VisibilityCaller } from "./visibility";

export interface OpenAiExtensionOptions {
  registry: Pick<ToolRegistry, "list" | "listVisible" | "maxResponseBytes">;
  openaiMentions?: boolean;
  jobQueue?: unknown;
  servesTaskMethods?: boolean;
  outputSchema?: "full" | "omit";
  /** The caller tools/list answers; the capability is offered only when it can see the tool. */
  visibility?: VisibilityCaller;
}

/** The `capabilities` fields createMcpServer spreads in: `{ extensions }` when at least one
 *  extension applies (Tasks when a queue backs it, `openai/mentions` when the flag is on and the
 *  tool is registered), else `{}`. */
export function extensionsCapability(
  opts: OpenAiExtensionOptions,
): { extensions: Record<string, Record<string, string>> } | Record<never, never> {
  const extensions: Record<string, Record<string, string>> = {};
  if (opts.jobQueue && opts.servesTaskMethods !== false) extensions[TASKS_EXTENSION] = {};
  if (mentionsEnabled(opts))
    extensions[OPENAI_MENTIONS_EXTENSION] = { searchTool: SEARCH_MENTIONS_TOOL };
  return Object.keys(extensions).length > 0 ? { extensions } : {};
}

/** The flag is on AND this caller's tools/list shows the tool (the capability names it, so the
 *  caller must be able to call it: scopes, static and persona visibility all apply). */
function mentionsEnabled(opts: OpenAiExtensionOptions): boolean {
  return (
    opts.openaiMentions === true &&
    opts.registry.listVisible(opts.visibility).some((d) => d.name === SEARCH_MENTIONS_TOOL)
  );
}

/** Domain-mode tools/list: the domain meta-tools, plus the mentions tool listed directly when the
 *  flag is on. Every registered tool stays callable by name either way. The caller's visible list
 *  is resolved here, so a bare listing still opens no session (same as the other branches). */
export function domainSurface(
  opts: OpenAiExtensionOptions & { visibility: VisibilityCaller },
): Tool[] {
  const visible = opts.registry.listVisible(opts.visibility);
  const direct = mentionsEnabled(opts)
    ? visible
        .filter((d) => d.name === SEARCH_MENTIONS_TOOL)
        .map(projectTool(opts.outputSchema, opts.registry.maxResponseBytes))
    : [];
  return [...domainTools(visible), ...direct];
}
