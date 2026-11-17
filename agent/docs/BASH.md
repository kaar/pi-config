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
- Prefer bash parameter expansion over `sed` for simple string substitution: `${var//search/replace}` instead of `sed 's/search/replace/g' <<<"$var"` [SC2001].
- Validate `cd` calls or rely on `errexit`; never `cd somewhere && do_stuff` without checking.
