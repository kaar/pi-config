# Codemode and Jev

Reference notes for Pi's `codemode` tool and TypeSafe's Jev classifier model. Jev details checked on 2026-09-30. Codemode and pi-web-access details updated on 2026-10-06 against Pi 1.0.4 and pi-web-access 0.36.0.

## Summary

- **Codemode** is a built-in Pi tool. The model writes a short JavaScript script, and the script calls the other tools. Only the script output goes back to the model.
- **Jev** is a classifier model from TypeSafe. It does not chat. It answers typed questions (choice, score, yes/no) about JSON state and returns probabilities.
- They are connected because Jev does not appear in `/model`. In a session, the model can call Jev only from a codemode script, with `models.classify()`. Extensions can call Jev directly.

## Codemode

### What it does

Codemode scripts run in a QuickJS sandbox, an isolated JavaScript engine. It has no Node APIs, direct network access, file system, or timers. Scripts reach external resources through `tools.<name>(args)` and `models`. The main benefits:

- Run several tool calls in parallel, for example with `Promise.allSettled`.
- Filter large output in the script, so the model sees only the part it needs.
- Call MCP tools that are not declared to the model.
- Call classifier models such as Jev.

Filtering results uses ordinary JavaScript, not another model. A called tool can still use a model internally. For example, pi-web-access's `fetch_content({ url, mode: "answer", prompt })` asks a chat model about fetched content. That model receives the question and source text, not the session conversation. This generates an answer, not an independent correctness check.

### Enable it

Codemode is off by default. Pi turns it on automatically only when an MCP server with `codemode` exposure connects. To enable it for every session, add this to `agent/settings.json` (symlinked as `~/.pi/agent/settings.json`):

```json
{
  "defaultTools": ["+codemode"]
}
```

The `+` keeps the default tools (`read`, `bash`, `edit`, `write`) and adds `codemode`. For one run only, list every tool, because `--tools` replaces the selection:

```sh
pi --tools read,bash,edit,write,codemode
```

### Script API

| API | Purpose |
|---|---|
| `tools.<name>(args)` | Call another tool. `ALL_TOOLS` lists them |
| `text(value)`, `console.*`, top-level `return` | Send output to the model |
| `image(dataUrlOrImageContent)` | Send an image to the model |
| `exit()` | End the script early |
| `searchTools(query, { limit, namespace })`, `describeTool(name)`, `describeNamespace(name)` | Find tools and inspect tools or namespaces (BM25 word-based ranking, not model judgment) |
| `store(key, value)`, `load(key)` | Keep JSON values across `codemode` calls. Values are saved in the session and follow the session branch |
| `models.getModelsOfType`, `getAvailableOfType`, `getModelOfType` | List the model catalog |
| `models.classify(model, context)`, `models.generateImages(model, context)` | Run classifier or image models with session credentials. Maximum 4 combined calls at a time per script. Further calls queue |

Chat models appear in the catalog, but scripts cannot run them directly through `models`.

Result types:

- `bash` returns `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }`, also for a non-zero exit code. `output` holds up to 1 MiB, which is much more than the 2000 lines or 50KB that the model sees from a direct call.
- MCP tools return their full `CallToolResult`, including `isError` and `structuredContent`.
- Tools with an output schema return structured data. `read` returns text or an image block; other tools without a schema return text.

Failed or blocked tool calls can reject. `Promise.allSettled()` keeps successful results, but inspect the shell result's `exit_code` and MCP `isError` even when a promise resolves.

An optional first line sets limits:

```js
// @options: {"max_output_tokens": 2000, "timeout_ms": 60000}
```

`max_output_tokens` defaults to 10000 and limits script output, not a separate model's response. Longer output keeps its start and end, and the full text goes to a temp file. `timeout_ms` has no default. Await tool calls: calls still running when the script ends are cancelled.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `codemode.mode` | `"on"` | `on`: declared tools stay declared, and their descriptions show how to call them from scripts. `only`: all tools are hidden from the model, which then reaches them only through `codemode` |
| `codemode.inlineBudget` | `3000` | Estimated tokens that tool declarations can use in the `codemode` description. Tools that do not fit are found with `searchTools()` |

In `mcp.json`, `"autoEnableCodemode": false` (top level, next to `mcpServers`) stops MCP servers from turning codemode on.

### MCP exposure

Each MCP server (and each tool, with `toolExposure`) has an `exposure` value. See [MCP: Exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure).

| Exposure | Declared to model | Listed in `codemode` description | Reached through |
|---|---|---|---|
| `codemode` (default) | No | No | Codemode scripts, `searchTools()` |
| `deferred` | Only after `tool_search` loads it | No | `tool_search`, then a direct call, or codemode |
| `direct` | Yes | In `only` mode | Direct call or codemode |
| `hidden` | No | No | Cannot be called |

`codemode-deferred` is now an alias for `codemode`. Both `codemode` and `deferred` tools support script calls and discovery through `tool_search`.

Tool calls from codemode scripts go through the normal tool pipeline, so `tool_call` and `tool_result` handlers (for example `git-guard`) still apply. These calls have the `codemode` call's id as `parentToolCallId`.

## Jev

### What it is

Jev is TypeSafe's "System One" model. It makes fast, structured decisions and does not generate text. You send:

- `state`: a JSON object with the input, for example a message, a log, or a file section.
- `questions`: named questions with fixed answer options.

Jev returns calibrated probabilities for each question. Your code decides what to do with them. The TypeSafe docs are in `~/Dev/jev/docs/vendor/typesafe/` and at [docs.typesafe.ai](https://docs.typesafe.ai/llms.txt). Experiments and research are in `~/Dev/jev`.

### Question types in Pi

| Pi type | TypeSafe name | `criteria` | Answer |
|---|---|---|---|
| `choice` | Choice | Object of option to description, up to 255 options | `{ choice, probabilities, confidence }` |
| `score` | Score | Array of ordered level descriptions, lowest first | `{ score, confidence }` (expected level index, can be fractional) |
| `bool` | Noul | `{ true: "...", false: "..." }` | `{ probability }` (probability of true, no confidence) |

Every question also has `instructions`. Check `result.stopReason === "stop"` before you use `result.answers`. The other values are `"error"` (with `errorMessage`) and `"aborted"`.

### Providers and credentials

| Provider | Model ID | Credential |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `~typesafe/jev-latest` | `OPENROUTER_API_KEY` or `/login` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |

To use a TypeSafe key directly, set it in the environment that starts Pi:

```bash
export TYPESAFE_API_KEY=your-key
```

Or store it in `agent/auth.json` (Git-ignored), and read it from the macOS Keychain:

```json
"typesafe": { "type": "api_key", "key": "!security find-generic-password -ws 'typesafe'" }
```

This setup already has OpenRouter credentials, so `openrouter` / `typesafe/jev-1.13` works without a TypeSafe key.

Pi includes direct classifier usage in session totals. TypeSafe's direct `jev-latest` has no catalog price in Pi, so its tokens show as no cost in `/session`. OpenRouter calls use the catalog price.

### Limits

From the TypeSafe [models page](https://docs.typesafe.ai/models.md). The limits can change without notice.

- 64k tokens per request. `state` plus the longest question must fit in 32k.
- 250,000 tokens per second and 1,200 requests per minute. Over the limit, the API returns `429`.
- Only input tokens are charged.

### Use Jev from codemode

After you enable codemode and set a credential, ask the model in plain language. The model writes a script like this:

```js
const jev = await models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
    tone: {
      type: "score",
      instructions: "How satisfied is the user?",
      criteria: ["Unhappy", "Neutral", "Very satisfied"],
    },
  },
});
if (result.stopReason !== "stop") return result.errorMessage ?? result.stopReason;
return result.answers;
```

To see which classifier models have credentials, use `await models.getAvailableOfType("classifier")`.

### Use Jev from an extension

Extensions call `ctx.modelRegistry.classify()` and do not need codemode:

```ts
const jev = ctx.modelRegistry.findOfType("classifier", "typesafe", "jev-latest");
if (jev) {
  const result = await ctx.modelRegistry.classify(jev, { state, questions }, { signal });
}
```

Pi's `examples/extensions/jev-router.ts` uses this in a virtual model. Jev rates the first prompt as `standard` or `complex`, and the router sends the planning to a stronger or a cheaper model. See [Virtual models](https://pi.dev/docs/latest/virtual-models).

## Example prompts for this repo

Triage `TODO.md`. The answers are easy to check against what you know:

```
Use codemode. Read TODO.md and split it into its "## " sections. Then send them to Jev
(typesafe/jev-latest) with models.classify(). Put each section in the state as its own
key (title + body). For each section, ask:

1. status (choice): done / open / idea-only
2. effort (choice): small (an hour or less) / medium (a day) / large (several days)
3. needs_research (bool): does it depend on reading or checking something external
   before work can start?

Return a table with title, status, effort, needs_research, and the top probability for
each answer. Only return the table, not the raw Jev output.
```

A second opinion for `git-guard`. `TODO.md` records that it blocks `GIT_EDITOR=true git rebase --continue && ...` as interactive:

```
Use codemode. Collect the bash commands from docs/research/tailnet-sessions/*.jsonl.
Ask Jev to classify each unique command as safe / interactive / destructive. Compare the
labels with what agent/extensions/git-guard.ts decides, and list only the disagreements.
```

## Cautions

- The sandbox restricts JavaScript, not tool permissions. `tools.bash()` retains its execution environment's permissions. A failed script does not undo completed tool actions.
- Jev confidence is not proof of correctness. Keep permissions and irreversible actions in deterministic code, such as `git-guard`.
- Every classify call sends the `state` to the provider. Do not put secrets in it.
- Jev has known weak spots. See TypeSafe's [jev-1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md) page.

## Sources

- [Pi Codemode: API and limits](https://pi.dev/docs/latest/codemode)
- [Pi Web Access: fetching and answer mode](https://github.com/nicobailon/pi-web-access#fetch_content). [Inspected answer implementation](https://github.com/nicobailon/pi-web-access/blob/9c9c0a8f1c452e6fdcf3cb43040f46e070534de1/page-query.ts)
- [Pi CLI: Enable codemode](https://pi.dev/docs/latest/cli#enable-codemode). Local copy: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/cli.md`
- [Pi models: Use classifier models](https://pi.dev/docs/latest/models#use-classifier-models)
- [Pi MCP: Exposure](https://pi.dev/docs/latest/mcp#control-tool-exposure)
- [Pi settings: Tools](https://pi.dev/docs/latest/settings#tools)
- [Pi provider authentication](https://pi.dev/docs/latest/providers)
- Classifier types: `pi-ai/dist/types.d.ts` (`ClassifierQuestion`, `ClassifierAnswer`, `ClassifierResult`)
- [TypeSafe docs index](https://docs.typesafe.ai/llms.txt), local copy in `~/Dev/jev/docs/vendor/typesafe/`
- Jev use in Pi extensions: `~/Dev/jev/docs/research/jev-pi-extensions.md`
