---
name: research-writer
description: Research a technical topic via web search and write the findings to a markdown document under docs/research/.
---

# Research Writer

Turn a research question into a durable markdown document the user can read offline and link from other docs.

**Announce at start:** "Researching <topic>. I'll search, synthesize, and write to `docs/research/<slug>.md`."

## Write the document

```sh
mkdir -p docs/research
```

Write to `docs/research/<slug>.md` with the `write` tool. Do not stop to ask the user to confirm content before writing; the user can edit.

If the document grows beyond ~600 lines, split off appendices into sibling files (`docs/research/<slug>-appendix-<topic>.md`) and link them. The main doc should stay scannable in one read.
