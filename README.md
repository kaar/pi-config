# PI Configuration

Personal configuration for the [PI](https://pi.dev/) coding agent. This repo is symlinked into `~/.pi/agent` via the install script.

## Setup

```bash
./install.sh
```

## Structure

- `agent/`: PI agent configuration (symlinked to `~/.pi/agent`)
  - `settings.json`: agent settings
  - `prompts/`: custom prompts
  - `skills/`: custom skills
- `install.sh`: symlink setup script

## Prompts

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`. See [docs/prompt-templates.md](docs/prompt-templates.md)

## Extensions

See [docs/extensions.md](docs/extensions.md)

- [Extensions docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [pi-web-access](https://github.com/nicobailon/pi-web-access)
- [pi-rewind](https://github.com/arpagon/pi-rewind): automatic git-based snapshots of your working tree, allowing you to rewind file changes and conversation state.
- [codemap](https://github.com/kcosr/codemap)
Codemap generates a compact, token-aware map of a codebase: files, symbols, and markdown structure. Designed for feeding context to LLMs and coding agents.

Did a bit of an experiment. I did not see too much value from it.

## Skills

See [docs/skills.md](docs/skills.md)

- [Skills docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)

### Location
- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)

### Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription

## Resources

- [PI](https://pi.dev/)
- [Pi Mono - Coding Agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/)
- [Packages](https://pi.dev/packages)
