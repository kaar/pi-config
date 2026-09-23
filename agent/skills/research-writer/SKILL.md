---
name: research-writer
description: Research a technical topic via web search and write the findings to a markdown document under docs/research/.
---

# Research Writer

Turn a research question into a durable markdown document the user can read offline and link from other docs.

**Announce at start:** "Researching <topic>. I'll search, synthesize, and write to `docs/research/<slug>.md`."

## Keep a chronological research log

Maintain `docs/research/<slug>-sources.md` alongside the main document. Append to it as each source is discovered; do not reconstruct it after the fact.

Each entry records, in discovery order:
- A timestamp (ISO 8601)
- The query or action that surfaced the source
- The source title and URL
- A one-line note on what you took from it

This lets the user trace exactly how the digest was informed. To append, read the log, then `write` the full accumulated list back (or use the `edit` tool to extend the last entry).

## Write the document

```sh
mkdir -p docs/research
```

Write to `docs/research/<slug>.md` with the `write` tool. Do not stop to ask the user to confirm content before writing; the user can edit.

If the document grows beyond ~600 lines, split off appendices into sibling files (`docs/research/<slug>-appendix-<topic>.md`) and link them. The main doc should stay scannable in one read.
