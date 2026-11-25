// Names shared by the OpenAI MCP extension surface (openai-extensions.ts) and the facade. A leaf
// module with no imports, so facade.ts can use the tool name without an import cycle.

/** The capability key ChatGPT looks for in `capabilities.extensions`. */
export const OPENAI_MENTIONS_EXTENSION = "openai/mentions";

/** The tool `openai/mentions` names as its `searchTool`. Read-only, app-visible. */
export const SEARCH_MENTIONS_TOOL = "search_mentions";
