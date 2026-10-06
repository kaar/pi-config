# Repository instructions

## Live configuration

`~/.pi/agent` is a symlink to `agent/` in this repository. These paths refer to the same files, not separate copies. Edits under either path change the live Pi configuration used across projects.

Use repository-relative paths such as `agent/settings.json` when working here. Do not replace the symlink with a directory or create a second configuration copy. Do not run `install.sh` unless the user asks to set up or repair the link.

## Instruction scope

This root `AGENTS.md` contains instructions for work in this repository. `agent/AGENTS.md` is the global instruction file exposed through `~/.pi/agent/AGENTS.md`. Changes to that file affect agents working in other repositories too.

Put repository-specific guidance here. Edit `agent/AGENTS.md` only when the user asks to change global agent instructions. Do not duplicate its general rules here.

## Safe changes

Keep changes limited to the requested files. Preserve unrelated edits and untracked files because other agents or active sessions can use this repository. Do not delete runtime files as part of cleanup.

Do not commit credentials, session data, logs, or caches. `agent/auth.json` contains credentials and is ignored by Git. Never print its contents.

Run `git status` before staging or committing. Stage only files changed for the current task, with explicit paths. Do not commit or push unless the user asks.
