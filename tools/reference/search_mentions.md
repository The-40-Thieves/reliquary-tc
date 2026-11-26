---
title: "search_mentions"
description: "Search note names and paths for the @-mention picker."
editUrl: false
---

Search note names and paths for the @-mention picker. Returns \{items: [\{type: "resource_link", uri, name, title, mimeType\}]\}: one item per note, best match first (file name matches before path matches), then most recently modified. An empty query returns the most recently modified notes. Each uri reads with the note's full text.

| | |
|---|---|
| **Domain** | search |
| **Scopes** | `read:notes` |
| **Access** | read |
| **Tags** | `read-only`, `domain:search` |
| **Profile** | core, full |

## Annotations {#annotations}

| Annotation | Value |
|---|---|
| Read-only | yes |
| Destructive | no |
| Idempotent | no |
| Accepts an idempotency key | no |

`Idempotent` is the advisory MCP `idempotentHint`. `Destructive` is also `yes` for a tool that
asks for confirmation only on some calls.

## Confirmation (human in the loop) {#confirmation-human-in-the-loop}

No human confirmation is required to call this tool.

## Input {#input}

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `vault` | `string` |  | — | Vault id. Omit to search every vault you can read. length 1–64; pattern `^[a-z0-9_-]+$` |
| `query` | `string` | yes | — | length ≤ 200 |
| `limit` | `integer` |  | `20` | range 1–50 |

## Output {#output}

| Field | Type | Always present | Description |
|---|---|---|---|
| `items` | `object[]` | yes | — |
| `items[].type` | `enum` | yes | One of: `"resource_link"` |
| `items[].uri` | `string` | yes | — |
| `items[].name` | `string` | yes | — |
| `items[].title` | `string` |  | — |
| `items[].mimeType` | `string` |  | — |

## Related tools {#related-tools}

Other tools in the `search` domain: [`query_datacore`](/tools/reference/query_datacore/), [`search`](/tools/reference/search/), [`search_and_read`](/tools/reference/search_and_read/), [`search_dql`](/tools/reference/search_dql/), [`search_jsonlogic`](/tools/reference/search_jsonlogic/), [`search_omnisearch`](/tools/reference/search_omnisearch/), [`search_regex`](/tools/reference/search_regex/), [`search_semantic`](/tools/reference/search_semantic/), [`search_text`](/tools/reference/search_text/), [`search_vault`](/tools/reference/search_vault/).

Back to the [tool catalog](/tools/tool-catalog/).
