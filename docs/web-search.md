# Web search & fetch providers

Guide for configuring the `web_search` and `fetch_content` tools provided by the [`pi-web-access`](https://www.npmjs.com/package/pi-web-access) package.

## How provider selection works

`pi-web-access` ships with four backends:

| Provider     | Needs              | Used for                | Notes                                         |
| ------------ | ------------------ | ----------------------- | --------------------------------------------- |
| `exa`        | `EXA_API_KEY` (optional) | search + fetch     | Falls back to public Exa MCP if no key        |
| `perplexity` | `PERPLEXITY_API_KEY`    | search                  | Paid only, no free tier                       |
| `gemini`     | `GEMINI_API_KEY`        | search + URL context    | Free tier is generous                         |
| `gemini-web` | Chromium login          | search                  | Slow, fragile, last resort                    |

Auto-select order in `web_search`:

1. `exa` (always available because of MCP fallback, so this wins by default)
2. `perplexity`
3. `gemini` (API or web)

Source: `~/Dev/pi-config/agent/npm/node_modules/pi-web-access/index.ts:175`.

Config lives in `~/.pi/web-search.json`. Env vars take precedence over file values.

---

## 1. Add a Gemini API key (recommended)

Free, biggest practical upgrade. Improves `fetch_content` on pages that block bots and gives you a real second provider.

### Get a key

1. Open <https://aistudio.google.com/apikey>.
2. Sign in with a Google account.
3. Click **Create API key**, pick or create a Google Cloud project, copy the key (starts with `AIza...`).

Free tier (as of 2026): Gemini 2.5 Flash and Flash-Lite have a free quota with per-minute and per-day rate limits. Sufficient for normal interactive coding use.

### Wire it in

```bash
mkdir -p ~/.pi
# create or update the config file
jq -n --arg key "$GEMINI_KEY" '{geminiApiKey: $key}' > ~/.pi/web-search.json
```

Or edit manually:

```json
{
  "geminiApiKey": "AIza..."
}
```

Alternative: export `GEMINI_API_KEY` in your shell profile. The env var wins over the file.

### Verify

```bash
jq '.geminiApiKey | length' ~/.pi/web-search.json   # should print a number > 30
```

Then in pi, run:

```
/reload
```

Ask the model to call `web_search` with `provider: "gemini"`. The session log will record `"provider":"gemini"` (or `"gemini-api"`) instead of `exa`.

---

## 2. Add an Exa API key (optional)

Worth it only if you notice the public Exa MCP being slow or rate-limited. Direct API is faster and tracks usage.

### Get a key

1. Open <https://dashboard.exa.ai/>.
2. Sign up, then **API Keys** → **Create new key**.
3. Free tier: 1000 searches/month. Keys start with a UUID-like string.

### Wire it in

Merge into the existing config:

```bash
tmp=$(mktemp)
jq --arg key "$EXA_KEY" '. + {exaApiKey: $key}' ~/.pi/web-search.json > "$tmp"
mv "$tmp" ~/.pi/web-search.json
```

Or set `EXA_API_KEY` in your shell.

### Verify

`pi-web-access` tracks monthly usage in `~/.pi/exa-usage.json` (created on first call). Once you have a key, the activity widget in pi shows usage and the monthly cap. After 1000 searches in a calendar month, `isExaAvailable()` returns `false` and auto-select falls through to the next provider.

---

## 3. Add a Perplexity API key (skip unless you already pay)

No free tier. Strong synthesized answers, but Gemini + Exa cover the same use cases.

### Get a key

1. Open <https://www.perplexity.ai/settings/api>.
2. Add a payment method (minimum $5 credit).
3. Generate a key.

### Wire it in

```bash
tmp=$(mktemp)
jq --arg key "$PPLX_KEY" '. + {perplexityApiKey: $key}' ~/.pi/web-search.json > "$tmp"
mv "$tmp" ~/.pi/web-search.json
```

Or export `PERPLEXITY_API_KEY`.

---

## 4. Pin a default provider

By default, auto-select always picks Exa first. If you want Gemini or Perplexity to be the default:

```json
{
  "provider": "gemini",
  "geminiApiKey": "AIza..."
}
```

Per-call override still works: the model can pass `provider: "exa"` to force Exa for a single search.

---

## 5. Skip Gemini Web (browser login)

`gemini-web` uses a Chromium profile to scrape gemini.google.com. It only activates if you explicitly request `provider: "gemini"` AND no `GEMINI_API_KEY` is set AND a Chromium profile with a Gemini login exists.

Don't bother setting this up. The API key path is faster, free at this volume, and doesn't depend on browser state. If you want to disable the path entirely, just make sure you don't have a Chromium profile at the default location (you don't).

---

## Auditing what got used

Every `web_search` call appends a `custom` event with `customType: "web-search-results"` to the session log. Extract the providers used in a session:

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

---

## Recommended setup for this repo

Minimum viable:

```json
{
  "geminiApiKey": "AIza..."
}
```

This keeps Exa MCP as the default (free, works fine), adds Gemini as a real fallback, and improves `fetch_content` quality. Skip Perplexity. Skip Exa key unless usage actually warrants it.
