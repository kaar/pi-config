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
