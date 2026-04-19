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
import { resolve } from "node:path";

const GIT_TIMEOUT = 5000;

export default function(pi: ExtensionAPI) {
  async function isGitRepo(cwd: string): Promise<boolean> {
    const { code } = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { timeout: GIT_TIMEOUT });
    return code === 0;
  }

  async function isGitTracked(filePath: string, cwd: string): Promise<boolean> {
    const abs = resolve(cwd, filePath);
    const { code } = await pi.exec("git", ["ls-files", "--error-unmatch", abs], { timeout: GIT_TIMEOUT });
    return code === 0;
  }

  async function gatePath(
    filePath: string,
    toolName: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (!(await isGitRepo(ctx.cwd))) return undefined;
    if (await isGitTracked(filePath, ctx.cwd)) return undefined;

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
