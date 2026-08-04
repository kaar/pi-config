# Web search and fetch

This repository currently loads [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) through `agent/settings.json`. It provides native `web_search` and `fetch_content` tools.

There is a browser-based alternative: [`web-search`](https://github.com/ogulcancelik/agent-skills/tree/main/skills/web-search), an Agent Skill maintained by ogulcancelik. It replaces the deprecated [`pi-web-browse`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-web-browse) extension. It does not replace every `pi-web-access` capability.

See [the replacement research](research/web-search-skill-replacement.md) for the evidence, comparison, and sources.

## Recommendation

Trial the `web-search` skill for normal web research before removing `pi-web-access`.

The skill is a good fit when a local browser, JavaScript rendering, no API key, and fewer ordinary HTTP bot blocks are the priority. Keep or restore the extension when native Pi tools, Exa, Gemini, Perplexity, or provider-backed fetching are required.

Do not run the two approaches as a blind A/B test. While the extension is installed, the agent may choose its native `web_search` tool instead of loading the skill. Use `/skill:web-search <query>` to force the skill during the initial test. Remove the extension and restart Pi only for the replacement test.

## 1. Install and test the skill

### Prerequisites

The skill requires:

- Node.js 20.19 or later
- Bun, which installs its dependencies
- Network access
- A Chromium-family browser: Chrome, Brave, Edge, or Chromium

Check the runtime:

```bash
node --version
bun --version
```

The local setup met the Node.js and Bun requirements during the initial review. No supported browser was found in `/Applications` or on `PATH`. Install one before testing. If the skill cannot find the browser automatically, set `WEB_SEARCH_BROWSER_BIN` to its executable path in the environment that starts Pi.

### Install for Pi

Install the skill globally for Pi:

```bash
npx skills add ogulcancelik/agent-skills --skill web-search --global --agent pi
```

The Skills CLI installs a global Pi skill in `~/.pi/agent/skills/`. Pi also discovers global skills in `~/.agents/skills/`, which is useful when the same skill should be shared with another agent.

If the first use reports missing dependencies, install them in the skill directory:

```bash
cd ~/.pi/agent/skills/web-search
bun install
```

The skill has executable code. Review its `SKILL.md`, `web-search.js`, and dependencies before running it.

### Verify the browser workflow

Start a new Pi session, then invoke the skill explicitly:

```text
/skill:web-search current release notes for <project>
```

The skill instructs the agent to call its bundled CLI from the absolute skill directory. The expected workflow is:

```bash
~/.pi/agent/skills/web-search/web-search.js --daemon status
~/.pi/agent/skills/web-search/web-search.js "current release notes for <project>" -n 5
~/.pi/agent/skills/web-search/web-search.js --from <result-set-id> --fetch 1,2
```

A search returns numbered results and a result-set ID. Fetch selected results within ten minutes because the result set expires after that period. The CLI can fetch an arbitrary URL and request untruncated content:

```bash
~/.pi/agent/skills/web-search/web-search.js --url https://example.com
~/.pi/agent/skills/web-search/web-search.js --url https://example.com --full
```

The CLI starts or reuses a local browser daemon by default. Its daemon controls are:

```bash
~/.pi/agent/skills/web-search/web-search.js --daemon status
~/.pi/agent/skills/web-search/web-search.js --daemon restart
~/.pi/agent/skills/web-search/web-search.js --daemon stop
```

If a page blocks one request, retry once, use another result, or fetch the URL directly. For repeated timeouts or blocks across several sites, inspect the daemon status and restart it. Reset the dedicated hidden browser profile only as a last resort. The skill explains that recovery procedure in `SKILL.md`.

## 2. Test the replacement without pi-web-access

After the skill works when forced, edit `~/.pi/agent/settings.json` and remove only `"npm:pi-web-access"` from the `packages` array. Keep the remaining package entries unchanged. Restart Pi and repeat the search and fetch test above.

To roll back, add the package back and restart Pi:

```json
{
  "packages": [
    "npm:pi-web-access",
    "git:github.com/HazAT/pi-interactive-subagents"
  ]
}
```

Do not delete `~/.pi/web-search.json` during the skill trial. The skill does not use that provider configuration, but leaving it in place makes the extension rollback immediate.

## 3. Share it with Claude Code later

After the Pi-only test succeeds, install for both Pi and Claude Code:

```bash
npx skills add ogulcancelik/agent-skills --skill web-search --global --agent pi --agent claude-code
```

The Skills CLI recommends symlinks, which keeps one canonical copy shared by the selected agents. Alternatively, place one reviewed copy in `~/.agents/skills/web-search/`. Pi discovers that location, and it matches the planned shared-skill layout in `TODO.md`.

## What the skill provides

| Capability | `web-search` skill |
| --- | --- |
| Search engines | Google, with DuckDuckGo fallback |
| Page access | Visit selected results or arbitrary URLs |
| Rendering | Local headless Chromium renders JavaScript before extraction |
| Output | Readable Markdown and source URLs through CLI output |
| Browser state | Persistent local daemon and a dedicated hidden profile |
| Credentials | No search API key |
| Limitations | Requires a local browser and is invoked as a skill workflow, not as native Pi tools |

## pi-web-access reference and rollback

`pi-web-access` has four backends:

| Provider | Needs | Used for | Notes |
| --- | --- | --- | --- |
| `exa` | `EXA_API_KEY` optional | Search and fetch | Falls back to public Exa MCP without a key |
| `perplexity` | `PERPLEXITY_API_KEY` | Search | Paid only |
| `gemini` | `GEMINI_API_KEY` | Search and URL context | API-backed provider |
| `gemini-web` | Chromium login | Search | Slow and fragile fallback |

Auto-selection in `web_search` prefers Exa, then Perplexity, then Gemini. Configuration is stored in `~/.pi/web-search.json`. Environment variables take precedence over the file.

### Configure Gemini

```bash
mkdir -p ~/.pi
jq -n --arg key "$GEMINI_KEY" '{geminiApiKey: $key}' > ~/.pi/web-search.json
```

Equivalent JSON:

```json
{
  "geminiApiKey": "AIza..."
}
```

Set `GEMINI_API_KEY` instead when the key must come from the environment. Verify the saved value without printing it:

```bash
jq '.geminiApiKey | length' ~/.pi/web-search.json
```

### Configure Exa

Merge the key with the existing configuration:

```bash
tmp=$(mktemp)
jq --arg key "$EXA_KEY" '. + {exaApiKey: $key}' ~/.pi/web-search.json > "$tmp"
mv "$tmp" ~/.pi/web-search.json
```

`EXA_API_KEY` is the environment alternative.

### Configure Perplexity

```bash
tmp=$(mktemp)
jq --arg key "$PPLX_KEY" '. + {perplexityApiKey: $key}' ~/.pi/web-search.json > "$tmp"
mv "$tmp" ~/.pi/web-search.json
```

`PERPLEXITY_API_KEY` is the environment alternative.

### Pin a provider

```json
{
  "provider": "gemini",
  "geminiApiKey": "AIza..."
}
```

Per-call provider overrides still take precedence.

## Audit pi-web-access usage

Each extension `web_search` call writes a `web-search-results` custom event to the Pi session log. Extract the selected providers with:

```bash
python3 -c "
import json, sys
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e.get('customType') != 'web-search-results': continue
    d = e['data']
    if d.get('type') == 'search':
        for q in d.get('queries', []):
            print(q.get('provider'), '|', q['query'])
" path/to/session.jsonl
```

## Related extension: pi-session-recall

[`pi-session-recall`](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-session-recall) is unrelated to web browsing. It adds `session_search` and `session_query` tools for on-demand recall from prior Pi session JSONL files. It has no background index or vector database. Consider it separately from this replacement decision.
