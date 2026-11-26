---
type: Added
---
- **`@`-mention search for ChatGPT.** A new read-only `search_mentions` tool returns notes whose file name or path matches a query, as `resource_link` items, so ChatGPT's @-mention picker can attach a note. Set `toolFacade.openaiMentions: true` to advertise it through the `openai/mentions` capability and list it on the `triad` and `domain` surfaces. The default is `false`, and with it the capability and those listings are unchanged. With no `vault` argument, which is how ChatGPT calls it, it searches every vault the caller can read; a token bound to one vault searches only that vault. Results respect each vault's folder ACL and Obsidian's Excluded files.
