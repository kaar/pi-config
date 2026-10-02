# Handoff Split Direction Implementation Plan

## Overview

`/handoff` always opens the successor Pi in a new pane to the right of the source pane. When the tab already has a left/right split, another right split produces narrow columns. This plan makes the handoff inspect the current Herdr tab layout first: if the tab contains any right split, the successor pane opens below the source pane (`--direction down`). Otherwise it opens to the right, as today.

## Current State Analysis

- The split direction is hard-coded: `herdr.splitPane("right", ctx.cwd)` at `agent/extensions/handoff/index.ts:153`.
- The Herdr adapter has no read-only layout query. It exposes only `splitPane`, `startPiAgent`, `sendText`, `sendKeys`, `focusAgent` (`agent/extensions/handoff/herdr.ts:12-23`).
- `Direction` is typed as `"left" | "right" | "up" | "down"` (`agent/extensions/handoff/herdr.ts:10`), but Herdr 0.9.1 `pane split` accepts only `--direction right|down` (Herdr docs `cli-reference.mdx:217`). `left` and `up` would fail at runtime. The adapter test loops over all four (`agent/extensions/handoff/handoff.test.cjs:427`).
- The command already validates `HERDR_ENV=1` and a non-empty `HERDR_PANE_ID` before any work (`agent/extensions/handoff/index.ts:141-144`).
- Every Herdr command is fail-fast. A failure reports `Handoff failed: [pane <id>: ]<detail>` and stops, with no retries or fallbacks (`agent/extensions/handoff/index.ts:164-167`, README "Failure recovery").
- The test harness records `args[1]` of every `herdr` call as an event, and the default mock returns empty stdout for everything except `split` (`agent/extensions/handoff/handoff.test.cjs:77-82`). A new JSON-returning command needs a default mock result.

## Desired End State

- Before the split, the command runs `herdr pane layout --pane <HERDR_PANE_ID>`.
- If any entry in `.result.layout.splits` has `direction: "right"`, the command splits with `--direction down`. Otherwise it splits with `--direction right`.
- The rest of the flow (agent start, paste, focus, Ctrl+G, notification text) is unchanged.
- A layout query failure or unusable output reports an error and creates no pane.
- `Direction` is narrowed to `"right" | "down"`.
- README and the file header comment describe the new behavior.

Verify with `node --test agent/extensions/handoff/handoff.test.cjs`, `npm --prefix agent/extensions run typecheck`, and a live handoff in a single-pane tab (opens right) and in a split tab (opens below).

### Key Discoveries:

- `herdr pane layout` returns `.result.layout` with `tab_id`, `zoomed`, `area`, `focused_pane_id`, `panes[]` (rects), and `splits[]` (Herdr docs `socket-api.mdx:238-241`). Live output from Herdr 0.9.1:
  ```json
  {"id":"cli:pane:layout","result":{"layout":{"area":{...},"focused_pane_id":"wW:p75","panes":[...],"splits":[],"tab_id":"wW:t1B","workspace_id":"wW","zoomed":false},"type":"pane_layout"}}
  ```
- `splits` is a flat list of every split node in the tab, including nested ones, each with `id`, `direction` (`right` or `down`), `ratio`, `rect`. A live three-pane tab reported `[{"id":"split_0_root","direction":"right"},{"id":"split_1_0","direction":"down"}]`. So "any right split in the tab" is `splits.some((s) => s.direction === "right")` with no tree walk.
- `herdr pane neighbor --current` in 0.9.1 resolved the server's focused pane (in another tab) instead of the calling pane, contrary to the docs (`cli-reference.mdx:226-227`). `pane layout --current` resolved correctly in the same test, but passing `--pane <HERDR_PANE_ID>` explicitly removes the dependency on `--current` resolution. `HERDR_PANE_ID` is already validated at `index.ts:141`.
- The adapter pattern for parsing JSON output with a specific error message is `parsePaneId` (`agent/extensions/handoff/herdr.ts:61-70`). The layout parser follows it.
- The adapter error format `herdr ${args[0]} ${args[1]} failed: ...` (`herdr.ts:32-33`) yields `herdr pane layout failed: ...` with no change.

## What We're NOT Doing

- No other layout heuristics (pane width, count of columns, neighbor-only checks). The user chose "any right split in the tab".
- No fallback to `right` when the layout query fails. That would contradict the extension's fail-fast policy.
- No configuration option or command flag to force a direction.
- No change to the split ratio, `--cwd`, `--no-focus`, or which pane gets split (still the source pane).
- No switch of `pane split --current` to `--pane <id>`. It works today; changing it is unrelated.
- No special handling for zoomed tabs. The decision uses `splits` as reported regardless of `zoomed`.
- No handling of the race where the layout changes between the query and the split.

## Implementation Approach

Keep the adapter thin and the policy in the command, matching the header comment in `herdr.ts:1-6` ("Callers decide"). The adapter gains one read-only method, `getPaneLayout(paneId)`, that returns the parsed `splits` list. `index.ts` gains a small pure function `splitDirection(layout)` and calls the query immediately before the split, after prompt generation, so the decision reflects the layout at split time (generation can take seconds, and the user may rearrange panes meanwhile).

## Alternative Approaches Considered

- **`pane edges` / `pane neighbor`**: answers "is there a pane to my right", not "does the tab have a right split". From the right-hand pane of `[A | B]` it would still split right. Rejected by the chosen semantics. `pane neighbor --current` also resolves the wrong pane in 0.9.1.
- **`layout.export` tree walk**: same information as `pane layout` but needs a socket call or recursive traversal. `pane layout` already flattens splits and has a CLI wrapper.
- **Decision inside the adapter (`chooseSplitDirection()` in `herdr.ts`)**: mixes policy into the CLI wrapper. Rejected to keep `herdr.ts` a thin wrapper.

## Phase 1: Herdr adapter layout query

### Overview

Add a read-only layout query to the adapter and narrow `Direction`. The command still splits right, so behavior is unchanged.

### Changes Required:

#### 1. Adapter
**File**: `agent/extensions/handoff/herdr.ts`
**Changes**:
- Narrow `Direction` to `"right" | "down"` with a comment that Herdr `pane split` accepts only these.
- Add types and a method:

```ts
export interface PaneLayout {
	splits: Array<{ direction: Direction }>;
}

/** Read the layout of the tab that contains a pane. */
getPaneLayout(paneId: string): Promise<PaneLayout>;
```

- Implementation: `run(["pane", "layout", "--pane", paneId])`, then `parseLayout(stdout)`.
- `parseLayout` follows `parsePaneId`: `JSON.parse` failure throws `herdr pane layout returned invalid JSON`. If `.result.layout.splits` is not an array, throw `herdr pane layout returned no layout`. Map entries to `{ direction }`, keeping only entries whose `direction` is `"right"` or `"down"` (unknown values are ignored, not fatal).

#### 2. Adapter tests
**File**: `agent/extensions/handoff/handoff.test.cjs`
**Changes** (in `describe("Herdr CLI adapter")`):
- Narrow the split-direction loop at line 427 to `["right", "down"]`.
- `getPaneLayout` invokes exactly `["pane", "layout", "--pane", destination]` with `HERDR_BIN_PATH` and returns the splits, including nested ones (`[{direction:"right"},{direction:"down"}]`).
- Returns `{ splits: [] }` for a single-pane tab.
- Ignores entries with unknown or missing `direction`.
- Rejects unusable output (`""`, `"not JSON"`, `"null"`, `"{}"`, `{"result":{}}`, `{"result":{"layout":{}}}`, `{"result":{"layout":{"splits":null}}}`) with `/herdr pane layout returned (invalid JSON|no layout)/`, one exec call.
- CLI failure reports `herdr pane layout failed: <stderr>`.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `node --test agent/extensions/handoff/handoff.test.cjs`
- [ ] Type checking passes: `npm --prefix agent/extensions run typecheck`
- [ ] No whitespace errors: `git diff --check`

#### Manual Verification:
- [ ] None. Behavior is unchanged in this phase.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Choose the split direction in /handoff

### Overview

Query the layout before splitting and split down when the tab has any right split. Update tests and docs.

### Changes Required:

#### 1. Command
**File**: `agent/extensions/handoff/index.ts`
**Changes**:
- Import `Direction` and `PaneLayout` types from `./herdr`.
- Add a pure helper:

```ts
/** Split below when the tab already has a left/right split, otherwise to the right. */
function splitDirection(layout: PaneLayout): Direction {
	return layout.splits.some((split) => split.direction === "right") ? "down" : "right";
}
```

- In the handler, replace the hard-coded split (line 153) with:

```ts
const layout = await herdr.getPaneLayout(sourcePaneId);
paneId = await herdr.splitPane(splitDirection(layout), ctx.cwd);
```

  `sourcePaneId` is `process.env.HERDR_PANE_ID`, captured into a `const` during the existing environment guard (line 141) so TypeScript narrows it to `string`.
- The layout query stays inside the existing `try` after generation. A failure there leaves `paneId` undefined, so the error has no pane prefix and no pane is created.
- Update the file header comment (lines 7-9): "in a new Herdr pane, to the right, or below when the tab already has a left/right split".
- Success notification text is unchanged.

#### 2. Command tests
**File**: `agent/extensions/handoff/handoff.test.cjs`
**Changes**:
- Add `layoutResult(splits = [])` helper returning `success(JSON.stringify({ result: { layout: { splits } } }))`. Make the default `exec` in `setup` return it for `args[1] === "layout"` (lines 77-82), and update the custom `exec` mocks in the ordering, stage-failure, and split-output tests the same way.
- Main flow test (line 155): event order becomes `[..., "loader closed", "layout", "split", "start", "send-text", "focus", "send-keys"]`. Expected calls gain `["pane", "layout", "--pane", environment.HERDR_PANE_ID]` first. Shift index-based lookups (`calls[1]` agent name, `executions()[1].args.at(-1)`, `executions()[2].args[3]`) by one, or better, look calls up by `args[1]` so they do not depend on position.
- Ordering test (line 254): stages become `["layout", "split", "start", "send-text", "focus", "send-keys"]`.
- Stage failure loop (line 345): add `layout` as the first stage. The pane prefix appears only for stages after `split`. Derive the expected `pane`/`agent` noun from the stage name instead of indexes.
- New direction tests, each asserting the `--direction` argument of the split call:
  - no splits: `right`
  - only `down` splits: `right`
  - root `right` split: `down`
  - root `down` split with nested `right` split: `down`
  - zoomed layout with a `right` split: `down`
- New failure test: layout returns unusable JSON. Error matches `/herdr pane layout returned/`, only one exec call, no split, source draft untouched, no pane prefix.
- Generation failure and Escape tests already assert `executions()` is empty. They now also prove the layout query is not run before generation.

#### 3. Documentation
**File**: `agent/extensions/handoff/README.md`
**Changes**:
- "How it works" step 3: insert `pane layout --pane <HERDR_PANE_ID>` before the split and change the split line to `pane split --current --direction right|down --cwd <cwd> --no-focus`. Add one sentence: the split goes down when any split in the current tab is a left/right split, otherwise right.
- "Failure recovery": a layout query failure reports an error and creates no pane.
- "Herdr and Pi notes": `pane split` accepts only `right` and `down`. The layout query passes `--pane` explicitly because `pane neighbor --current` resolved the focused pane instead of the calling pane in Herdr 0.9.1.
- Manual checks: replace "The new pane opens on the right" with the two cases below.

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `node --test agent/extensions/handoff/handoff.test.cjs`
- [ ] Type checking passes: `npm --prefix agent/extensions run typecheck`
- [ ] No whitespace errors: `git diff --check`

#### Manual Verification:
- [ ] After `/reload`, `/handoff` from a single-pane tab opens the successor to the right.
- [ ] `/handoff` from the left pane of `[A | B]` opens the successor below A.
- [ ] `/handoff` from the right pane of `[A | B]` opens the successor below B.
- [ ] `/handoff` from a tab with only a top/bottom split opens the successor to the right of the source pane.
- [ ] The rest of the flow (prompt paste, focus, external editor) is unchanged in both directions.
- [ ] Running `/handoff` while viewing a different tab than the source (source in background) still uses the source tab's layout.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit Tests:
- Adapter: exact `pane layout --pane <id>` arguments, parsing of flat nested splits, unknown directions ignored, unusable output rejected, CLI failure detail.
- Command: direction decision for empty, down-only, right, nested, and zoomed layouts. Layout query runs after generation and before the split. Layout failure stops before the split without a pane prefix.

### Integration Tests:
- None automated. The harness mocks all Herdr calls and makes no live requests.

### Manual Testing Steps:
1. In a single-pane tab, run `/handoff test right` and confirm the new pane opens on the right.
2. Close it, split the tab right manually, run `/handoff test down` from each side, and confirm the new pane opens below the source.
3. In a tab with only a down split, run `/handoff` and confirm it opens to the right.
4. Start a handoff, switch to another tab during generation, and confirm the split uses the source tab's layout.

## Performance Considerations

One extra local `herdr` CLI call (a few milliseconds) after generation, which takes seconds. Negligible.

## Migration Notes

None. No configuration or persisted state. Run `/reload` in Pi after the change.

## References

- Handoff extension: `agent/extensions/handoff/index.ts`, `agent/extensions/handoff/herdr.ts`, `agent/extensions/handoff/README.md`
- Prior handoff plan: `docs/plans/2026-09-29-handoff-fast-generation-and-editor.md`
- Herdr 0.9.1 docs: `cli-reference.mdx` (Panes section, lines 203-231), `socket-api.mdx` (`pane.layout`, lines 238-241; `layout.export` split nodes, lines 247-258)
- Similar implementation: `parsePaneId` at `agent/extensions/handoff/herdr.ts:61-70`
