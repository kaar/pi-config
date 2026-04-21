# PI Configuration

Personal configuration for the [PI](https://pi.dev/) coding agent. This repo is symlinked into `~/.pi/agent` via the install script.

## Setup

Creates a symlink from `~/.pi/agent` to the `agent/` directory in this repo.

```bash
./install.sh
```

## Structure

- `agent/`: PI agent configuration (symlinked to `~/.pi/agent`)
  - `settings.json`: agent settings (provider, model, thinking level, packages)
  - `extensions/`: TypeScript extensions that hook into the agent
  - `prompts/`: custom prompt templates
  - `skills/`: custom skills
  - `bin/`: bundled binaries (e.g. `fd`)
  - `sessions/`: active session data
  - `todos/`: todo tracking
- `docs/`: documentation
- `AGENTS.md`: guidelines for parallel agents (tool usage, git safety rules, writing style)
- `install.sh`: symlink setup script

## Extensions

TypeScript extensions that add functionality to the agent. See [docs/extensions.md](docs/extensions.md).

### [pi-web-access](https://github.com/nicobailon/pi-web-access)
Web browsing in PI. Provides tools for searching the web, fetching URL content, and retrieving stored results.

- **web_search** - Search the web with one or more queries, returns AI-synthesized answers with citations
- **fetch_content** - Fetch and extract readable content from URLs, YouTube videos, GitHub repos, and local videos
- **get_search_content** - Retrieve full stored content from previous web_search or fetch_content calls

### Custom Extensions

- **git-guard** - Safety checks for destructive git operations
- **git-checkpoint** - Automatic git-based checkpoints
- **todos** - Todo management within sessions

### Third-Party Extensions


## Prompts

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`. See [docs/prompt-templates.md](docs/prompt-templates.md).

- **review-staged** - Review staged git changes for bugs, security issues, and error handling gaps

## Skills

Reusable, invokable capabilities. See [docs/skills.md](docs/skills.md).

### Custom Skills

- **generate-commit-message** - Generates a commit message from staged changes
- **review-staged-changes** - Reviews staged changes for bugs, security issues, and error handling gaps (P0-P3 priority)

### Skill Locations

- Global: `~/.pi/agent/skills/`, `~/.agents/skills/`
- Project: `.pi/skills/`, `.agents/skills/` (searched up to git root)

### Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription

## Docs

- [extensions.md](docs/extensions.md) - Extension authoring guide
- [skills.md](docs/skills.md) - Skills authoring guide
- [prompt-templates.md](docs/prompt-templates.md) - Prompt template syntax
- [session.md](docs/session.md) - Session management

## Resources

- [PI](https://pi.dev/)
- [Pi Mono - Coding Agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/)
- [Extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Skills docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
- [Packages](https://pi.dev/packages)
