## Tool Usage
- NEVER use `sed` or `cat` to read files. Always use the read tool.
- Use `offset` and `limit` for ranged reads. Omit both when reading a file in full.
- Read every file in full before editing it.
- Use `rg` (ripgrep) instead of `grep`.

## Editing
- Keep edits minimal. Match only the smallest unique region needed.
- When changing multiple locations in one file, use a single edit call with multiple entries.
- Do not guess file contents. Read first, then edit.

## Git
- ONLY stage files you changed in this session: `git add <specific-files>`
- NEVER use `git add -A`, `git add .`, `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`
- Run `git status` before committing to verify you are only staging your own files

## Behavior
- Do not start implementing or modifying code unless explicitly asked
- When the user mentions an issue or topic, discuss it first
- Wait for explicit instructions like "implement this", "fix this", "create this"
- When drafting file content (docs, blog posts, config), apply changes directly without asking for confirmation

## Style
- Be concise and direct
- No emojis in commits, issues, PRs, or code
- No filler phrases ("I'd be happy to", "Great question!", "Here's the thing:")
- Avoid em dashes as sentence interrupters. Use periods, commas, or parentheses instead

## Markdown
- When writing markdown files, do not hard-wrap prose. One paragraph per line; let the editor soft-wrap.

## Shell scripts
- Shebang: `#!/usr/bin/env bash` (portable, picks up Homebrew bash on macOS)
- Strict mode at the top of every script:
  ```
  set -o errexit
  set -o nounset
  set -o pipefail
  ```
- Guard required env vars early, using `:-` so the check itself is safe under `nounset`:
  `[ -z "${VAR:-}" ] && echo "VAR not set" && exit 1;`
- Always quote variable expansions: `"$var"`, `"${arr[@]}"`. Never `$var` unquoted.
- Use `${VAR:-default}` for optional vars and `${1:-}` for optional positional args.
- Prefer `[[ ... ]]` over `[ ... ]` for new scripts (safer parsing, supports `&&`/`||`/`=~`). Match the surrounding style when editing existing scripts.
- Send errors and usage to stderr: `echo "..." >&2`.
- Prefer early exits with `&&` chains for guard clauses over nested `if` blocks:
  `[ -d "$path" ] && echo "Already exists: $path" && exit 1;`
- Pass arguments through with `"$@"`, never `$*` or `$@` unquoted.
- Use `local` for variables inside functions.
- Prefer `$(cmd)` over backticks for command substitution.
- Use `mktemp` for temp files; clean up with `trap 'rm -rf "$tmp"' EXIT`.
- Use `command -v foo >/dev/null` to check for a binary (not `which`).
- Validate `cd` calls or rely on `errexit`; never `cd somewhere && do_stuff` without checking.
