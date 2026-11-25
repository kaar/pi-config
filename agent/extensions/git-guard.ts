/**
 * Git Guard Extension
 *
 * Intercepts tool calls to guard against unintended modifications.
 * Use /git-guard off or /git-guard on to change protection for this session.
 *
 * File guarding (write/edit):
 *  - Allows canonical /tmp, /var/folders, and current-project .agents trees.
 *  - Rechecks exempt paths on every call so inner symlinks cannot escape.
 *  - Prompts when target file is in a different git repository than cwd.
 *  - Prompts when target file is not tracked by git (staged or committed).
 *  - In non-interactive mode, blocks by default. Does nothing outside git repos.
 *
 * Bash guarding:
 *  - Blocks interactive git commands that would hang waiting for an editor,
 *    including `git commit` without a message source.
 *  - Blocks destructive git commands (reset --hard, clean -f, checkout ., branch -f, etc.).
 *  - Prompts when a command overwrites a tracked file via `git show ... >` or `cp`.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { resolve, dirname, join, relative, isAbsolute, sep } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

const COMMIT_PATTERN = /git\s+commit/;
const COMMIT_MESSAGE_SOURCE_PATTERN = /(?:^|\s)(-m|--message|-F|--file|-C|--reuse-message|--no-edit)(?:\s|=|$)/;

const INTERACTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+merge(?!.*(--no-edit|-m|-F|--file))/,
  /^(?![\s\S]*(?:GIT_EDITOR|core\.editor))[\s\S]*git\s+rebase\s+--continue/,
  /git\s+tag\s+(-a|--annotate|-s|--sign)(?!.*(-m|--message|-F|--file))/,
];

const DESTRUCTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[a-zA-Z]*f/,
  /git\s+checkout\s+\./,
  // Allows: list, show, create (read-only)
  /git\s+stash(?!\s+(list|show|create))(?:\s|$)/,
  /git\s+rm\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force)/,
  // Force-moving a branch ref can orphan commits (recoverable only via reflog)
  /git\s+branch\b[^;&|\n]*\s(?:-f|--force)(?=[\s;&|]|$)/,
];

const GIT_TIMEOUT = 5000;

function nearestExistingDir(dir: string): string {
  // Keep dangling links so realpath rejects them instead of trusting their parent.
  while (!lstatSync(dir, { throwIfNoEntry: false })) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

function canonicalPath(path: string): string | null {
  try {
    const ancestor = nearestExistingDir(path);
    return resolve(realpathSync(ancestor), relative(ancestor, path));
  } catch { return null; }
}

function containsPath(root: string | null, path: string | null): boolean {
  if (!root || !path) return false;
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

const temporaryRoots = ["/tmp", "/var/folders"].filter(existsSync).map(canonicalPath);

function overwriteTargets(command: string): string[] {
  return command.split(/&&|\|\||[;|\n]/).flatMap((segment) => {
    const gitShow = segment.match(/git\s+show\b[^>]*?(?<![0-9&>])>(?![>&])\s*(\S+)/);
    const cp = segment.match(/(?:^|\s)cp\s+(.+)/);
    const target = gitShow?.[1] ?? (() => {
      if (!cp) return undefined;
      const args = cp[1].split(/\s+/).filter((arg) => !arg.startsWith("-"));
      return args.length >= 2 ? args.at(-1) : undefined;
    })();

    if (!target) return [];
    const unquoted = (target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))
      ? target.slice(1, -1)
      : target;
    return /[$`*?]/.test(unquoted) ? [] : [unquoted];
  });
}

const sessionTouchedFiles = new Set<string>();

export default function(pi: ExtensionAPI) {
  let enabled = true;

  pi.registerCommand("git-guard", {
    description: "Show or change Git Guard status: /git-guard [on|off]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const action = args.trim();
      if (action === "on" || action === "off") {
        enabled = action === "on";
        ctx.ui.setStatus("git-guard", enabled ? undefined : "Git Guard OFF");
      } else if (action) {
        ctx.ui.notify("Usage: /git-guard [on|off]", "warning");
        return;
      }
      ctx.ui.notify(
        enabled ? "Git Guard is on." : "Git Guard is off. Use /git-guard on to restore protection.",
        enabled ? "info" : "warning",
      );
    },
  });

  async function getGitRoot(dir: string): Promise<string | null> {
    const realDir = existsSync(dir) ? realpathSync(dir) : dir;
    const { code, stdout } = await pi.exec("git", ["-C", realDir, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT });
    if (code !== 0) return null;
    const root = stdout.trim();
    return existsSync(root) ? realpathSync(root) : null;
  }

  async function isGitTracked(filePath: string, gitDir: string): Promise<boolean> {
    const { code } = await pi.exec("git", ["-C", gitDir, "ls-files", "--error-unmatch", filePath], { timeout: GIT_TIMEOUT });
    return code === 0;
  }

  async function promptOrBlock(
    message: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const reason = `Blocked ${toolName}: ${message}`;
    if (!ctx.hasUI) return { block: true, reason };

    // Pi 1.6.1 supports blockedKind, but the pinned development types predate it.
    const dialogOptions: ExtensionUIDialogOptions & { blockedKind: "permission" } = { blockedKind: "permission" };
    const choice = await ctx.ui.select(
      `⚠️ ${message}\n\nAllow ${toolName}?`,
      ["Yes, allow this once", "No, block it"],
      dialogOptions,
    );
    return choice === "Yes, allow this once" ? undefined : { block: true, reason };
  }

  async function gatePath(
    filePath: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const abs = resolve(ctx.cwd, filePath);
    const canonical = canonicalPath(abs);
    const isTemporary = temporaryRoots.some((root) => containsPath(root, canonical));
    const cwdRoot = isTemporary ? null : await getGitRoot(ctx.cwd);
    if (isTemporary || (cwdRoot && containsPath(canonicalPath(join(cwdRoot, ".agents")), canonical))) {
      // Exempt calls must not create or retain path-string approvals.
      sessionTouchedFiles.delete(abs);
      return undefined;
    }
    if (!cwdRoot) {
      sessionTouchedFiles.add(abs);
      return undefined;
    }
    if (!canonical) {
      return { block: true, reason: `Blocked ${toolName}: cannot resolve "${filePath}" safely` };
    }
    if (sessionTouchedFiles.has(abs)) return undefined;

    const fileRoot = await getGitRoot(nearestExistingDir(dirname(abs)));
    let message: string | undefined;
    if (!fileRoot || fileRoot !== cwdRoot) {
      message = `"${filePath}" is outside the current git repository`;
    } else {
      const realAbs = existsSync(abs) ? realpathSync(abs) : abs;
      if (!await isGitTracked(realAbs, cwdRoot) && existsSync(abs)) {
        message = `"${filePath}" is not tracked by git`;
      }
    }

    const result = message ? await promptOrBlock(message, toolName, ctx) : undefined;
    if (!result) sessionTouchedFiles.add(abs);
    return result;
  }

  async function gateOverwrite(
    command: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const targets = overwriteTargets(command);
    const trackedTargets: string[] = [];

    for (const target of targets) {
      const abs = resolve(ctx.cwd, target);
      if (!existsSync(abs)) continue;
      const realAbs = realpathSync(abs);
      if (await isGitTracked(realAbs, ctx.cwd)) trackedTargets.push(target);
    }

    if (trackedTargets.length === 0) return undefined;
    return promptOrBlock(`command overwrites tracked file(s): ${trackedTargets.join(", ")}`, "bash", ctx);
  }

  pi.on("tool_call", async (event, ctx) => {
    if (!enabled) return undefined;
    if (isToolCallEventType("write", event)) {
      return gatePath(event.input.path, "write", ctx);
    }
    if (isToolCallEventType("edit", event)) {
      return gatePath(event.input.path, "edit", ctx);
    }
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      if (INTERACTIVE_GIT_PATTERNS.some((p) => p.test(command))) {
        return { block: true, reason: "Blocked: interactive git command" };
      }
      if (DESTRUCTIVE_GIT_PATTERNS.some((p) => p.test(command))) {
        return { block: true, reason: "Blocked: destructive git command" };
      }
      const overwrite = await gateOverwrite(command, ctx);
      if (overwrite) return overwrite;
      if (COMMIT_PATTERN.test(command) && !COMMIT_MESSAGE_SOURCE_PATTERN.test(command)) {
        return { block: true, reason: "Blocked: interactive git commit (would open editor)" };
      }
    }
    return undefined;
  });
}
