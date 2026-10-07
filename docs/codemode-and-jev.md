# Codemode and Jev

Reference notes for Pi's `codemode` tool and TypeSafe's Jev classifier model. Jev details checked on 2026-09-30. Codemode and pi-web-access details updated on 2026-10-06 against Pi 1.0.4 and pi-web-access 0.36.0. Architecture and workflow notes also draw on Armin Ronacher's [What is Codemode](https://lucumr.pocoo.org/2026/10/6/codemode/), published October 6, 2026.

## Summary

- **Codemode** is a built-in Pi tool for coordinating calls inside Pi. The model writes a short JavaScript script that calls tools or non-chat models. Only the script output goes back to the model.
- **Jev** is a classifier model from TypeSafe. It does not chat. It answers typed questions (choice, score, yes/no) about JSON state and returns probabilities.
- They are connected because Jev does not appear in `/model`. In a session, the model can call Jev only from a codemode script, with `models.classify()`. Extensions can call Jev directly.

## Codemode

### What it does

Codemode scripts run in a QuickJS sandbox, an isolated JavaScript engine. It has no Node APIs, direct network access, file system, or timers. Scripts reach external resources through `tools.<name>(args)` and `models`. The main benefits:

- Run several tool calls in parallel, for example with `Promise.allSettled`.
- Filter large output in the script, so the model sees only the part it needs.
- Call MCP tools that are not declared to the model.
- Call classifier models such as Jev and generate images.

Filtering results uses ordinary JavaScript, not another model. A called tool can still use a model internally. For example, pi-web-access's `fetch_content({ url, mode: "answer", prompt })` asks a chat model about fetched content. That model receives the question and source text, not the session conversation. This generates an answer, not an independent correctness check.

### Pi host versus execution environment

Ronacher calls these two sides the "brain" and the "hands". The harness is Pi, the program that manages the agent. The execution environment is where tools such as bash run. They can share a machine, but remote or sandboxed execution can separate their file systems and permissions.

Codemode runs on the Pi host in QuickJS within a WebAssembly runtime. Its JavaScript sandbox is separate from any sandbox for bash. Calling `tools.bash()` sends work to the execution environment. It does not give the script direct access to that environment.

Codemode complements command-line programs rather than replacing them. Use bash to combine programs in the execution environment. Use codemode to combine Pi tools, inspect structured results, and call classifier or image APIs. Image payloads and subagent coordination need support from the harness that ordinary shell output does not provide.

### Working with batches and saved state

The article describes a sample-first workflow: inspect 5–10 items, then write a script to process the larger batch. Make sure that the larger response keeps the same structure. Some MCP servers change their output format with the result count, so a successful sample does not guarantee a successful batch.

Run independent calls in parallel, inspect failures, and return only the needed fields or summary. Use `Promise.allSettled()` when partial success is useful. Filtering and sorting do not require another model request, but `models.classify()` and tools with internal AI calls do.

Use `store()` for small JSON state such as IDs, cursors, or summaries. Successful scripts append store entries to the session transcript on the Pi host. Resumed sessions retain them, and branches see only their own history. Failed scripts do not save their store changes. Pi 1.0.4 limits each value to 262144 JSON characters and the total store to 1048576.

Saved state is not a checkpoint of a running workflow. Completed tool actions remain after a script failure, and resuming the session does not resume an interrupted script. Ronacher identifies durable workflows, which recover interrupted work, as an open problem rather than an existing guarantee.

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
| `image(dataUrlOrImageContent)` | Send an image payload to the model and save a temporary image file |
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

### MCP design guidance from the article

MCP means Model Context Protocol, a protocol for tools and resources. With Pi's default `codemode` exposure, scripts discover tools as needed instead of loading every declaration into the model context. A server summary still tells the model which servers are available. Other exposure modes remain available.

Ronacher recommends these properties for servers used from codemode:

- Return structured JSON through `structuredContent` and describe it with `outputSchema`.
- Keep the result structure consistent across small and large batches.
- Plan a separate transfer path for large binary data where MCP cannot carry it, such as pre-signed upload URLs.
- Account for the lack of a standard way to combine tool searches across multiple servers. Pi's local `searchTools()` does not resolve that protocol limitation.

Some MCP servers expose their own code execution tool. Calling one from Pi creates code nested inside code, with extra escaping and a separate execution scope. The inner script cannot call Pi's outer tools. Prefer ordinary structured tool calls when the server offers them.

Ronacher also identifies image and binary handling and reliability with smaller models as unresolved limits. Keep scripts short and inspect response structures rather than assuming every server or model handles complex workflows reliably.

### Generate and inspect images

The article shows image generation as another use of codemode beyond MCP. Find an authenticated image model, then pass generated image blocks to `image()`, not `text()`:

```js
const [painter] = await models.getAvailableOfType("image");
if (!painter) return "No authenticated image model is available.";
const result = await models.generateImages(painter, {
  input: [{ type: "text", text: "A red fox in the snow, watercolor" }],
});
if (result.stopReason !== "stop") return result.errorMessage ?? result.stopReason;
for (const block of result.output) {
  if (block.type === "image") image(block);
  else text(block.text);
}
```

`image()` sends the actual image payload to the model and saves a temporary artifact on the Pi host. Do not assume that its path exists in a separate execution environment. Printing base64 data as text does not let the model see the image. Image generation can take minutes, so avoid a short script deadline.

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

Ronacher's article shows Jev classifying GitHub issues in parallel, saving the results, and returning only the most frustrated reports. It also shows a bounded game-debugging loop: read state, classify the next action, execute it, and repeat. These examples combine tool calls and typed model decisions without asking the main chat model to handle every item or step. Pi 1.0.4 queues classifier and image calls beyond four concurrent calls per script. This is not a general four-call limit for all tools.

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

- Armin Ronacher, [What is Codemode](https://lucumr.pocoo.org/2026/10/6/codemode/), October 6, 2026. Architecture, real-session examples, MCP recommendations, and open problems. Exact API limits above follow Pi 1.0.4's codemode reference.
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
