# Replacing pi-web-access with the web-search skill

## Decision

`web-search` from [ogulcancelik/agent-skills](https://github.com/ogulcancelik/agent-skills/tree/main/skills/web-search) is a viable replacement for interactive browser-based research. It is not a feature-for-feature replacement for `pi-web-access`.

Use the skill when the priority is free search through a local browser, JavaScript rendering, and better resilience to ordinary HTTP bot blocking. Retain `pi-web-access` when native `web_search` and `fetch_content` tools or provider-backed search are required.

## Evidence

The upstream `pi-web-browse` extension is explicitly deprecated in favor of the `agent-skills` repository. The replacement is the `web-search` Agent Skill, which is agent-agnostic and contains the browser CLI plus its instructions.

The skill searches Google first, falls back to DuckDuckGo when Google returns no results, and can fetch arbitrary URLs or selected search results. It uses a persistent local browser daemon by default. Search result sets are cached for ten minutes so numbered results can be fetched later.

The skill requires Node.js 20.19 or later, Bun to install dependencies, network access, and a Chromium-family browser. It uses no search API key.

The local machine meets the Node.js and Bun prerequisites (`v26.5.0` and `1.3.13` during this review). No Chrome, Brave, Edge, or Chromium application was found in `/Applications` or on `PATH`, so a supported browser must be installed or configured before testing the skill.

Pi supports Agent Skills and discovers global skills from both `~/.pi/agent/skills/` and `~/.agents/skills/`. The Skills CLI recognizes Pi as `pi` and installs a global Pi skill in `~/.pi/agent/skills/`.

## Capability comparison

| Area | `pi-web-access` extension | `web-search` skill |
| --- | --- | --- |
| Pi interface | Native `web_search` and `fetch_content` tools | Agent reads `SKILL.md` and invokes a bundled CLI through Bash |
| Search source | Configurable Exa, Perplexity, Gemini, and Gemini Web | Google, with DuckDuckGo fallback |
| Credentials | Optional or required provider API keys, depending on provider | No search API key |
| Rendering | Provider-dependent fetch path | Local Chromium renders JavaScript pages |
| Browser session | Not required | Persistent headless browser daemon by default |
| Result selection | Tool arguments | Result-set ID plus `--from <id> --fetch <numbers>` |
| Suitability | Provider search and direct tool integration | Interactive web research and difficult browser-rendered pages |

## Recommended evaluation

1. Install a supported Chromium-family browser. Chrome, Brave, Edge, and Chromium are supported. If auto-detection cannot find it, set `WEB_SEARCH_BROWSER_BIN` to its executable path in the environment that launches Pi.
2. Install only the skill for Pi: `npx skills add ogulcancelik/agent-skills --skill web-search --global --agent pi`.
3. In the installed skill directory, run `bun install` if the first invocation reports missing dependencies.
4. Start a new Pi session and force the workflow once with `/skill:web-search <query>`. This confirms that Pi loads the skill instead of choosing the extension's native web tools.
5. Run a search and fetch two results. Confirm that URLs and readable Markdown are returned.
6. Temporarily remove `npm:pi-web-access` from `~/.pi/agent/settings.json`, restart Pi, and repeat the same test. The repository configuration currently lists that package under `packages`.
7. Restore the package entry and restart Pi if the evaluation fails or if native provider tools remain necessary.

Use a shared installation only after the Pi-only trial succeeds. Pi can load the same skill from `~/.agents/skills/`, and the Skills CLI can install the skill for multiple agents with `--agent pi --agent claude-code`.

## Operational commands

From the directory that contains the installed `SKILL.md`:

```bash
bun install
./web-search.js --daemon status
./web-search.js "Web Search API documentation" -n 5
./web-search.js --from <result-set-id> --fetch 1,2
./web-search.js --url https://example.com
./web-search.js --daemon restart
```

Direct calls start or reuse the daemon. If one site blocks a request, retry once or use another source. For repeated daemon failures, inspect its status, restart it, and only then consider resetting the dedicated hidden browser profile described by the skill.

## Sources

- [web-search skill instructions](https://github.com/ogulcancelik/agent-skills/blob/main/skills/web-search/SKILL.md)
- [web-search skill README](https://github.com/ogulcancelik/agent-skills/tree/main/skills/web-search)
- [pi-web-browse deprecation notice](https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-web-browse)
- [Pi Skills documentation](../skills.md)
- [Skills CLI documentation](https://github.com/vercel-labs/skills#install-a-skill)
