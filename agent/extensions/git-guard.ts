/**
 * Git Guard Extension
 *
 * Intercepts tool calls to guard against unintended modifications.
 *
 * File guarding (write/edit):
 *  - Prompts when target file is in a different git repository than cwd.
 *  - Prompts when target file is not tracked by git (staged or committed).
 *  - In non-interactive mode, blocks by default. Does nothing outside git repos.
 *
 * Bash guarding:
 *  - Blocks interactive git commands that would hang waiting for an editor.
 *  - Blocks destructive git commands (reset --hard, clean -f, checkout ., etc.).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { resolve, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";

const INTERACTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+commit(?!.*(-m|--message|-F|--file|-C|--reuse-message|--no-edit))/,
  /git\s+merge(?!.*(--no-edit|-m|-F|--file))/,
  /git\s+rebase\s+--continue(?!.*(GIT_EDITOR|core\.editor))/,
  /git\s+tag\s+(-a|--annotate|-s|--sign)(?!.*(-m|--message|-F|--file))/,
];

const DESTRUCTIVE_GIT_PATTERNS: RegExp[] = [
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[a-zA-Z]*f/,
  /git\s+checkout\s+\./,
  /git\s+stash(?!\s+(list|show|create))(?:\s|$)/,
];

const GIT_TIMEOUT = 5000;

function nearestExistingDir(dir: string): string {
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

export default function(pi: ExtensionAPI) {
  async function getGitRoot(dir: string): Promise<string | null> {
    const { code, stdout } = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT });
    return code === 0 ? stdout.trim() : null;
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

    const choice = await ctx.ui.select(
      `⚠️ ${message}\n\nAllow ${toolName}?`,
      ["Yes, allow this once", "No, block it"],
    );
    return choice === "Yes, allow this once" ? undefined : { block: true, reason };
  }

  async function gatePath(
    filePath: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const abs = resolve(ctx.cwd, filePath);
    const fileDir = nearestExistingDir(dirname(abs));

    const cwdRoot = await getGitRoot(ctx.cwd);
    if (!cwdRoot) return undefined;

    const fileRoot = await getGitRoot(fileDir);
    if (!fileRoot || realpathSync(fileRoot) !== realpathSync(cwdRoot)) {
      return promptOrBlock(`"${filePath}" is outside the current git repository`, toolName, ctx);
    }

    if (await isGitTracked(abs, cwdRoot)) return undefined;

    return promptOrBlock(`"${filePath}" is not tracked by git`, toolName, ctx);
  }

  pi.on("tool_call", async (event, ctx) => {
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
    }
    return undefined;
  });
}
