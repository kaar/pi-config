/**
 * Git Guard Extension
 *
 * Blocks pi from modifying files not tracked by git (staged or committed).
 * Intercepts write and edit tool calls. Prompts the user to allow or block
 * when a target file is untracked. In non-interactive mode, blocks by default.
 * Does nothing outside git repositories.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { resolve, dirname } from "node:path";

const GIT_TIMEOUT = 5000;

export default function(pi: ExtensionAPI) {
  async function getGitRoot(dir: string): Promise<string | null> {
    const { code, stdout } = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT });
    return code === 0 ? stdout.trim() : null;
  }

  async function isGitTracked(filePath: string, gitDir: string): Promise<boolean> {
    const { code } = await pi.exec("git", ["-C", gitDir, "ls-files", "--error-unmatch", filePath], { timeout: GIT_TIMEOUT });
    return code === 0;
  }

  async function gatePath(
    filePath: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    const abs = resolve(ctx.cwd, filePath);
    const fileDir = dirname(abs);

    const cwdRoot = await getGitRoot(ctx.cwd);
    // Not in a git repo, nothing to guard
    if (!cwdRoot) return undefined;

    const fileRoot = await getGitRoot(fileDir);
    const isOutsideRepo = !fileRoot || fileRoot !== cwdRoot;

    if (isOutsideRepo) {
      const reason = `Blocked ${toolName}: "${filePath}" is outside the current git repository`;
      if (!ctx.hasUI) return { block: true, reason };

      const choice = await ctx.ui.select(
        `⚠️ "${filePath}" is outside the current git repository.\n\nAllow ${toolName}?`,
        ["Yes, allow this once", "No, block it"],
      );
      return choice === "Yes, allow this once" ? undefined : { block: true, reason };
    }

    if (await isGitTracked(abs, cwdRoot)) return undefined;

    const reason = `Blocked ${toolName}: "${filePath}" is not tracked by git`;

    if (!ctx.hasUI) return { block: true, reason };

    const choice = await ctx.ui.select(
      `⚠️ "${filePath}" is not tracked by git.\n\nAllow ${toolName}?`,
      ["Yes, allow this once", "No, block it"],
    );

    return choice === "Yes, allow this once" ? undefined : { block: true, reason };
  }

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event)) {
      return gatePath(event.input.path, "write", ctx);
    }
    if (isToolCallEventType("edit", event)) {
      return gatePath(event.input.path, "edit", ctx);
    }
    return undefined;
  });
}
