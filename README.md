# PI Configuration

Personal configuration for the [PI](https://pi.dev/) coding agent. This repo is symlinked into `~/.pi/agent` via the install script.

## Setup

```bash
./install.sh
```

## Structure

- `agent/` — PI agent configuration (symlinked to `~/.pi/agent`)
  - `settings.json` — agent settings
  - `prompts/` — custom prompts
  - `skills/` — custom skills
- `install.sh` — symlink setup script

## Extensions

- [pi-web-access](https://www.npmjs.com/package/pi-web-access)

## Skills

- [Skills docs](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)

### Location
- Global:
  - `~/.pi/agent/skills/`
  - `~/.agents/skills/`
- Project:
  - `.pi/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)

## Resources

- [PI](https://pi.dev/)
- [Pi Mono - Coding Agent](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/)
- [Packages](https://pi.dev/packages)
