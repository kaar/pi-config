# Git Guard `/tmp` Write Exemption Implementation Plan

## Overview

Allow Pi `write` and `edit` tool calls to create or modify files contained by `/tmp` without an approval prompt from `git-guard`. This lets an agent use a temporary file as an intermediate artifact, such as when it is pursuing an alternative implementation, while retaining the guard for external repositories and non-Git files elsewhere.

The exemption applies to the physical `/tmp` directory tree, not to every OS temporary directory. On macOS, `/tmp` resolves to `/private/tmp`, so both spellings refer to the same allowed tree. A path reached through a symlink under `/tmp` is exempt only when its resolved existing target or ancestor remains inside that tree.

## Current State Analysis

`git-guard.ts` currently resolves every `write` and `edit` path against the current working directory, then sends the first write to that resolved path through `gatePath`. `gatePath` locates the current repository and the target path's repository before allowing it. A target with no Git root, such as `/tmp/implementation-notes.md`, is classified as outside the current repository and is blocked in non-interactive mode or requires approval in the TUI.

The extension already canonicalizes existing paths with `realpathSync` before checking Git tracking. It also has `nearestExistingDir`, which safely finds an existing ancestor for a new target. These pieces can identify the physical location of a proposed temporary-file write without adding dependencies or weakening Git checks elsewhere.

Bash overwrite detection is separate. It only prompts when `git show >` or `cp` would overwrite a Git-tracked target, so it already permits untracked `/tmp` targets. This change must not alter that logic, Git command protections, commit approval, or the per-session allowlist for ordinary files.

## Desired End State

A `write` or `edit` event targeting a path physically within `/tmp` returns no block result before `git-guard` invokes Git. The agent can use both a lexical `/tmp/...` path and the macOS canonical `/private/tmp/...` spelling. A new file under `/tmp` is allowed, as is an existing regular file under that directory.

The check must not permit a path merely because its textual prefix starts with `/tmp`. `/tmp-other/file`, `/var/folders/...`, and external destinations reached through a symlink in `/tmp` remain subject to the existing guard. A repository path, an external non-Git path, and a tracked-file overwrite through Bash retain their current behavior.

### Key Discoveries:

- `write` and `edit` share the same resolved-path and first-touch flow at `agent/extensions/git-guard.ts:304-317`, so one `gatePath` exemption covers both tools.
- `gatePath` resolves the target before discovering Git roots at `agent/extensions/git-guard.ts:198-221`; its `!fileRoot || fileRoot !== cwdRoot` branch is what currently classifies `/tmp` as outside the repository.
- `nearestExistingDir` at `agent/extensions/git-guard.ts:54-61` and `realpathSync` already imported at `:15` allow a new target and an existing symlink target to be classified by physical location.
- Bash overwrite protection is independent at `agent/extensions/git-guard.ts:223-240` and only blocks targets reported as Git tracked, so no Bash change is needed.
- The current test harness transpiles the extension and dispatches mocked tool events at `agent/extensions/tests/git-guard.test.cjs:11-35`, but its coverage is currently Bash-only.
- On this host, `realpath /tmp` returns `/private/tmp`; comparing canonical existing locations makes the intended `/tmp` exemption work with either path spelling without exempting the broader `os.tmpdir()` location.

## What We're NOT Doing

- Exempting Node's `os.tmpdir()` directory, which is `/var/folders/...` on this host and is broader than the requested `/tmp` scope.
- Exempting arbitrary untracked paths, paths outside the current Git repository, or other mount points.
- Treating a string prefix such as `/tmp-other` as temporary.
- Permitting a `/tmp` symlink that resolves outside the canonical `/tmp` tree.
- Changing Bash overwrite detection, destructive Git command blocking, interactive Git command blocking, or commit approval.
- Adding a setting, UI prompt, command, dependency, or user-facing documentation for this fixed local policy.
- Altering the session-touched-file cache semantics for paths that are not exempt.

## Implementation Approach

Keep the policy local to `gatePath`, before any Git command runs. Add a small path predicate that receives the already-resolved absolute target path. It will:

1. Resolve `/tmp` once to its canonical root with `realpathSync`.
2. Find the target itself when it exists, otherwise its nearest existing ancestor, using `nearestExistingDir`.
3. Canonicalize that existing location with `realpathSync`.
4. Use `node:path` containment semantics, such as `relative` plus `isAbsolute`, to accept only the canonical root or a descendant. Do not use a raw string prefix.

This means a non-existent `/tmp/new-file` is accepted because its existing ancestor canonicalizes within `/tmp`. An existing `/tmp/link/outside-file` is not accepted when the file or nearest existing ancestor resolves outside `/tmp`. Calling the predicate at the beginning of `gatePath` leaves `sessionTouchedFiles` behavior intact: a successful temporary write can still be recorded for the current session, but it never needs a prompt or Git lookup.

## Alternative Approaches Considered

**Use `os.tmpdir()` as the allowlisted root:** This would follow the runtime's preferred temporary directory, but on this host it allows `/var/folders/...`, not the requested `/tmp` tree. It broadens the external-write exception unnecessarily, so it is rejected.

**Allow paths whose strings begin with `/tmp`:** This is short but incorrectly allows `/tmp-other` and can allow writes through symlinks that leave `/tmp`. It is rejected in favor of canonical containment.

**Bypass all untracked or external new files:** This would remove the exact protection the extension provides for accidental writes outside the working repository. It is rejected.

## Phase 1: Add Canonical `/tmp` Path Gating and Tests

### Overview

Add the narrow `/tmp` exemption to the shared path gate and give the existing test harness direct `write` and `edit` coverage. No runtime configuration or other extension behavior changes.

### Changes Required:

#### 1. Temporary-path predicate and early exit
**File**: `agent/extensions/git-guard.ts`
**Changes**:

- Extend the `node:path` import at `:15` with the containment helpers needed for a boundary-safe descendant check.
- Define a canonical `/tmp` root and an `isTemporaryPath(abs: string)` helper near `nearestExistingDir`.
- Canonicalize the existing target or its nearest existing ancestor, then accept only the canonical root or a strict descendant. This must accept the `/private/tmp` alias on macOS, reject sibling prefixes, and reject symlink escapes.
- At the start of `gatePath` after resolving `abs`, return `undefined` when `isTemporaryPath(abs)` is true. The check must run before `getGitRoot` and `isGitTracked`.
- Update the header's file-guarding description to state that `/tmp` writes are allowed without a prompt.

The helper should follow this shape, with exact names left to implementation:

```ts
const TMP_ROOT = realpathSync("/tmp");

function isTemporaryPath(abs: string): boolean {
  const existing = realpathSync(nearestExistingDir(abs));
  const pathFromTmp = relative(TMP_ROOT, existing);
  return pathFromTmp === "" || (!pathFromTmp.startsWith(`..${sep}`) && pathFromTmp !== ".." && !isAbsolute(pathFromTmp));
}
```

#### 2. File-tool event tests
**File**: `agent/extensions/tests/git-guard.test.cjs`
**Changes**:

- Add a small helper beside `check` that dispatches a `write` or `edit` event with `input.path` and the same non-interactive repository context.
- Create a unique fixture directory beneath `/tmp` for tests and remove it in test cleanup. Do not invoke a Pi write tool or persist an artifact beyond the test.
- Assert that a non-existent file under the fixture directory is allowed for both `write` and `edit`.
- Resolve the fixture directory with `fs.realpathSync` and assert that a path expressed through the canonical `/private/tmp` alias is also allowed on macOS. Keep this assertion platform-safe by deriving the spelling from the fixture rather than hard-coding `/private/tmp`.
- Assert that an external sibling such as `/tmp-git-guard-test/...` is still blocked in non-interactive mode. This proves the containment check has a path-boundary rule rather than a `/tmp` prefix rule.
- Add a symlink fixture under the temporary directory that points to a non-`/tmp` existing directory, if the test environment permits symlink creation. Assert that an existing target through it is still blocked. If the platform cannot create symlinks, skip only this assertion with the test runner's explicit skip facility, not the entire file-tool test group.
- Keep all existing Bash cases unchanged. They prove the separate Bash policy has not been broadened.

### Success Criteria:

#### Automated Verification:

- [ ] Git Guard tests pass: `node --test agent/extensions/tests/git-guard.test.cjs`
- [ ] Extension type checking passes: `npm --prefix agent/extensions run typecheck`
- [ ] No whitespace errors exist: `git diff --check`
- [ ] Tests prove that both `write` and `edit` allow a new `/tmp` descendant in non-interactive mode.
- [ ] Tests prove that the canonical spelling of the same temporary location is allowed.
- [ ] Tests prove that `/tmp-git-guard-test/...` remains blocked.
- [ ] Tests prove, where symlinks are available, that a `/tmp` symlink resolving outside the temporary tree remains blocked.
- [ ] Existing Bash overwrite, destructive-command, interactive-command, and commit-approval tests continue to pass unchanged.

#### Manual Verification:

- [ ] Run `/reload` in Pi to load the changed extension.
- [ ] From a Git repository, ask the agent to use `write` to create `/tmp/git-guard-manual-check.txt`; confirm no Git Guard prompt appears.
- [ ] Ask the agent to write an external non-Git path outside `/tmp`; confirm Git Guard still prompts in the TUI or blocks in non-interactive mode.
- [ ] Ask the agent to overwrite a tracked repository file with `git show ... > tracked-file`; confirm the existing Bash approval still appears.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation that the interactive checks succeeded before treating the change as complete.

## Testing Strategy

### Unit Tests:

- New non-existent files beneath lexical `/tmp` for `write` and `edit`.
- Canonical-path access to the same fixture directory.
- The `/tmp` root boundary versus a sibling with a similar prefix.
- Existing targets and ancestors reached through a symlink that exits `/tmp`.

### Integration Tests:

- The existing transpile-and-VM harness exercises the registered Pi `tool_call` handler with a non-interactive context. It verifies the same event path Pi uses without executing agent-provided shell commands.
- Existing Bash tests remain the regression suite for unrelated guard policies.

### Manual Testing Steps:

1. Reload Pi after implementation.
2. In a repository-backed session, use a `write` tool call to create a new file under `/tmp`.
3. Confirm that the call proceeds without a Git Guard dialog.
4. Attempt a `write` to a new path outside both the repository and `/tmp`.
5. Confirm that Git Guard does not silently allow it.
6. Run a known guarded Bash overwrite against a tracked file and confirm that its prompt behavior is unchanged.

## Performance Considerations

For each first `write` or `edit` path in a session, the exemption performs a bounded synchronous canonicalization of `/tmp` and the target's nearest existing ancestor. It replaces the otherwise asynchronous Git-root and tracked-file lookups for allowed temporary targets. The normal non-temporary path behavior and Git timeout remain unchanged.

## Migration Notes

No migration, persisted state, configuration, dependency, or reload-specific data change is required. Reload Pi after deployment so extension discovery uses the updated `git-guard.ts`. Existing sessions immediately receive the new policy for subsequent tool calls.

## References

- User request: exempt `/tmp/` from external-write blocking so an agent may use temporary files for an alternative solution.
- Shared file gate: `agent/extensions/git-guard.ts:198-221`.
- Write and edit event registration: `agent/extensions/git-guard.ts:304-317`.
- Existing-ancestor helper: `agent/extensions/git-guard.ts:54-61`.
- Bash overwrite gate: `agent/extensions/git-guard.ts:223-240`.
- Existing test harness: `agent/extensions/tests/git-guard.test.cjs:1-35`.
- Type-check script: `agent/extensions/package.json:5`.
