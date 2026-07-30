# Design Spec: Context Compression Extension (pi-headroom)

Status: draft
Date: 2026-07-30
Source investigation: headroomlabs-ai/headroom (Apache 2.0)

## Summary

A pi extension that compresses large tool outputs before they reach the LLM, ported from the compression core of [Headroom](https://github.com/chopratejas/headroom). Headroom's own numbers: 60-95% token reduction on JSON tool outputs, 15-20% overall for coding agents. The extension takes only the compression part (content detection, per-type compressors, reversible retrieval) and drops everything else Headroom ships (proxy, memory, telemetry, learn, subscription tracking, evals, install tooling), which is roughly 90% of that codebase.

Verdict on feasibility: yes, and the pi extension model is a better host for this than Headroom's own proxy. Headroom needs a proxy because it works on opaque HTTP traffic. Pi hands extensions the structured message array before every LLM call (`context` event) and lets tools be registered for retrieval. The two hardest problems Headroom solves (wire-format fidelity, prompt-cache safety across an HTTP boundary) mostly disappear inside pi.

## What Headroom's core actually is

Findings from reading the codebase (~300k lines total):

1. **ContentRouter**: detects what a blob is (JSON array, build log, search output, diff, code, prose) and dispatches to a per-type compressor.
2. **SmartCrusher** (JSON arrays): statistical selection, not ML. Keeps first/last items, errors, anomalies/outliers, change points in time series, query-relevant rows; dedupes similar items; summarizes the rest. Implemented in Rust (~25 files).
3. **LogCompressor / SearchCompressor / DiffCompressor**: heuristic compressors for build logs, grep output, diffs.
4. **CodeCompressor**: tree-sitter AST skeletonization (keep imports/signatures/types, compress bodies).
5. **Kompress**: a fine-tuned ModernBERT ONNX model for prose token-level extraction. Heavy (261MB+ model), last-resort only.
6. **CCR (Compress-Cache-Retrieve)**: originals stored locally, a `<<ccr:HASH>>` marker left in the compressed text, and a `headroom_retrieve` tool injected so the LLM can pull the original back on demand.
7. **Safety rails**: token-validate every compression (revert if it didn't shrink), fail open on any error, never touch content already sent (prompt-cache safety).

Headroom's internal `REALIGNMENT/` audit is required reading for this port. Their original design scored and dropped old messages from history, which busted the provider prompt cache on every trigger. The corrected invariants (their words, condensed):

- Passthrough is sacred. Compress only new content on its first send; never mutate anything already sent.
- Deterministic: same input bytes produce same output bytes, every run. No timestamps, no randomness.
- Token-validated: if compression didn't shrink the content, forward the original.
- Position-preserving: never reorder, split, or merge blocks.
- Reversible: originals always retrievable.
- Fail open: any compressor error means passthrough, never a broken request.

These invariants are the design; the compressors are replaceable details.

## Why pi makes this easy

| Headroom problem | Pi equivalent |
| --- | --- |
| Parse/reserialize provider HTTP payloads byte-faithfully | `context` event hands you the message array as a deep copy; return a modified copy. No wire format involved. |
| Store originals in a CCR store (SQLite/memory + TTL) | The session file already stores originals. `context` modifications are non-destructive per LLM call. The retrieval tool reads the original from `ctx.sessionManager`. |
| Inject a retrieve tool by mutating the tools array (cache-bust risk) | `pi.registerTool()` registers `expand_output` once, always present. |
| Detect provider, auth mode, endpoint shape | Not applicable. Pi abstracts the provider. |
| Proxy deployment, wrap CLIs, supervisors | Drop a `.ts` file in `~/.pi/agent/extensions/`. |

The one Headroom problem that does carry over: **prompt-cache safety requires byte-stable history**. Since `context` fires before every LLM call and rewrites the whole array each time, the compressed form of a given tool result must be identical on every subsequent call. Determinism plus memoization handles this (see Invariants).

## Architecture

```
context event (before every LLM call)
  │
  ├─ walk messages; for each toolResult message:
  │    │
  │    ├─ cache hit on (entryId, contentHash)?  → substitute memoized bytes
  │    │
  │    └─ miss (first time this result is sent):
  │         ├─ size gate: content < threshold → passthrough, memoize as-is
  │         ├─ detect(content) → json-array | log | search | diff | other
  │         ├─ compress via matching compressor
  │         ├─ validate: est. tokens must shrink ≥ 20%, else passthrough
  │         ├─ append marker: "[pi-headroom: N items/lines elided,
  │         │    expand_output(id=\"<toolCallId>\") for full output]"
  │         └─ memoize compressed bytes
  │
  └─ return { messages } with substitutions applied

expand_output tool (registered once, always active)
  │
  └─ look up toolCallId in ctx.sessionManager.getBranch(),
     return the ORIGINAL content from the session entry
```

### Hook choice: `context`, not `tool_result`

Two candidate hooks were considered:

- `tool_result`: modifies the result once, at execution time. The compressed form is what gets persisted in the session. Simple, but lossy: forks, `/tree`, and the user's own session history lose the original, and the retrieval tool then needs a separate on-disk store (reimplementing Headroom's CCR store).
- `context`: modifies only what is sent to the LLM, per call. The session keeps originals, so retrieval is a session lookup and reversibility is structural. Requires the memoization discipline described above.

`context` wins. It is the same "live zone" model Headroom's realignment converged on, with the session file acting as the CCR store for free.

### Compressor set (phase 1, all heuristic, pure TypeScript)

Port the algorithms, not the code. All are deterministic and dependency-free.

**Detector** (~100 lines). Ordered checks on the text content: parseable JSON with an array ≥ 20 items → json-array; ≥ 30% of lines match timestamp/level prefixes → log; ripgrep/grep `path:line:` shape → search; unified diff headers → diff; else passthrough.

**JsonArrayCrusher** (SmartCrusher-lite, ~400 lines). For arrays of similar objects:
- Always keep: first 3 and last 2 items, any item containing error/failure indicators, numeric outliers (> 2 sigma on numeric fields), items matching keywords from the latest user message.
- Dedupe: items identical after nulling volatile fields (timestamps, ids) collapse to one representative plus a count.
- Summarize the elided remainder: item count, per-field type/range/cardinality digest.
- Emit as compact JSON with an `_elided` summary entry carrying the marker.

**LogCompressor** (~200 lines). Keep head (20 lines) and tail (40 lines); in the middle keep every line matching error/warn/fail/exception/panic plus 2 lines of context; collapse runs of near-identical lines (same after stripping timestamps/hex/numbers) to `<line> [x N]`.

**SearchCompressor** (~100 lines). Cap matches per file (5), cap files (30), keep a per-file overflow count, keep total-match summary line.

**DiffCompressor** (phase 2, optional). Per-file stats for large diffs, full hunks only for files under a size cap.

Explicitly not ported:
- **Kompress ML model**: 261MB+ ONNX download, needs onnxruntime-node, marginal gains on prose relative to the structured-content compressors. Headroom itself time-budgets it aggressively and fails open constantly.
- **CodeCompressor**: pi's `read` tool already truncates at 50KB, and skeletonizing code the agent asked to read is risky for correctness. Revisit only if measurement shows large code blobs dominating.
- **CacheAligner, ICM, scoring, relevance ranking, rolling windows, summarizers**: Headroom's own audit condemned the history-dropping machinery (~25k LOC scheduled for deletion). Do not port. Pi's `/compact` handles history; this extension never touches old turns' semantics, only their byte representation, and only via the memoized first-send form.

## Invariants (enforced, with tests)

1. **First-send-freeze**: the substituted bytes for a given session entry are computed once and never change for the life of the session (in-memory memo keyed by entryId + content hash). On restart the memo is empty, but recomputation is deterministic, so the bytes come out identical and the provider cache prefix survives. A `COMPRESSOR_VERSION` constant is baked into the memo key; bumping it is a deliberate one-time cache bust.
2. **Determinism**: no `Date.now()`, no randomness, no dependence on iteration order of anything unordered. Property test: compress(x) === compress(x) across runs.
3. **Shrink-or-passthrough**: estimated tokens (chars/4) must drop ≥ 20%, else the original is sent. Compression overhead below ~2KB content is never worth it; size-gate first.
4. **Never touch**: user messages, assistant messages, thinking blocks, system prompt, images, custom extension messages. Only `toolResult` content blocks of type `text`.
5. **Fail open**: every compressor call wrapped; any throw logs to a debug file and passes the original through. A circuit breaker (3 consecutive failures → passthrough for the session) copies Headroom's pipeline guard.
6. **Marker fidelity**: every compressed result carries exactly one marker naming the real `toolCallId`. `expand_output` must resolve every marker it ever emitted; if the entry is not on the current branch, say so in the tool result instead of erroring.

## Implementation options considered

**A. Pure TypeScript reimplementation (chosen).** ~1,000-1,500 lines in `~/.pi/agent/extensions/pi-headroom/`. No native deps, hot-reloadable with `/reload`, debuggable. The heuristic compressors are the 80% of Headroom's value and are straightforward to port from their Rust/Python sources. Apache 2.0 permits it; attribute in the header.

**B. Rust sidecar reusing headroom-core.** A ~200-line wrapper crate exposing `stdin JSON → stdout compressed` over the actual battle-tested SmartCrusher. True byte-parity with upstream and its test corpus. Cost: build/distribute a binary per platform, subprocess latency per call, and tracking an upstream that is mid-realignment (their Phase B rewrites the transform layer). Keep as an upgrade path if option A's crusher quality disappoints; the extension's compressor interface should stay narrow enough to swap in a subprocess backend.

**C. WASM build of headroom-core.** Portable, but headroom-core's dependency tree (tokenizers, hashing, optional ONNX plumbing) has unverified wasm compatibility. Not worth de-risking for a personal extension.

**D. Run the Headroom proxy, point pi at it via `pi.registerProvider("anthropic", { baseUrl })`.** Zero extraction, full feature set. Rejected: drags in the entire Python+Rust stack (~500MB Docker or a pip environment with supervisors), and the current Python proxy has known cache-killer bugs per Headroom's own REALIGNMENT audit, with the fix being a 13-week rewrite. Also the proxy would fight pi's own provider handling (OAuth, streaming, retry).

## Extension surface

```
~/.pi/agent/extensions/pi-headroom/
├── index.ts          # hook wiring, memo, circuit breaker
├── detect.ts         # content type detection
├── crush-json.ts     # JsonArrayCrusher
├── crush-log.ts      # LogCompressor
├── crush-search.ts   # SearchCompressor
├── estimate.ts       # token estimation, shrink validation
└── test/             # fixture-based tests, run with vitest or node:test
```

- `pi.on("context", ...)`: the compression pass described above.
- `pi.registerTool("expand_output", ...)`: params `{ id: string, query?: string }`. Returns the original content for that toolCallId from the session; `query` optionally filters to matching lines (mirrors Headroom's BM25-in-store search, downgraded to substring/regex).
  - `promptSnippet`: "Retrieve the full uncompressed output of an earlier tool call".
  - `promptGuidelines`: "Compressed tool outputs end with a [pi-headroom ...] marker. Call expand_output with the id from the marker only when the summary is insufficient."
- `pi.registerCommand("headroom", ...)`: `/headroom` shows per-session stats (calls compressed, tokens before/after estimate, savings %); `/headroom off|on` toggles; state kept via `pi.appendEntry("pi-headroom-config", ...)`.
- `ctx.ui.setStatus("pi-headroom", "…saved ~Nk tok")`: running savings counter in the footer.

## Measurement plan

Before building compressors, add a measure-only mode (one evening of work): the `context` handler logs size, detected type, and would-be savings per tool result to `~/.pi/agent/pi-headroom-stats.jsonl` without modifying anything. A week of normal use answers which compressors matter for actual pi sessions and whether the 15-20% coding-agent figure holds here. Build only the compressors the data justifies. Note that pi's built-in 50KB truncation already caps the worst blobs; the win here is turning blind truncation into structure-aware selection.

## Risks

- **Model confusion from markers**: the model may call `expand_output` reflexively and erase the savings. Mitigation: guidelines wording, and the stats command tracks expansion rate; if a content type gets expanded > 30% of the time, stop compressing that type (that decision must be per-session-start, not mid-session, to preserve byte stability).
- **Correctness on JSON the agent needs verbatim**: e.g. the agent reads JSON intending to edit it. Mitigation: never compress results of `read` on paths ending `.json` (file edits need exact bytes); only compress `bash` and MCP/custom tool outputs initially.
- **Memo/session drift**: `/fork`, `/tree` rewind, and branch switches change which entries exist. The memo is keyed by entryId + content hash, so stale entries simply never get looked up; no invalidation logic needed.
- **Compaction interaction**: pi's compaction summarizes using the context. It should see originals, not compressed forms. `session_before_compact` receives entries from the session (originals), not the `context`-modified copy, so this is safe by construction; verify with a test.

## Open questions

1. Should `write`/`edit` tool results (small confirmations) be excluded by tool name allowlist instead of the size gate alone? Probably yes: allowlist `bash` + MCP tools first, expand later.
2. Marker syntax: Headroom uses `<<ccr:HASH>>`. Angle brackets can collide with XMLish prompts. Proposed `[pi-headroom: ... id=...]` instead; confirm no rendering issues in TUI.
3. Is chars/4 estimation good enough for the shrink gate, or should the gate use `ctx.getContextUsage()` deltas? Start with chars/4; it only gates, never breaks.
