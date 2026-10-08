import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHerdr } from "./cli";
import { generateName } from "./naming";

export default function(pi: ExtensionAPI) {
	const herdr = createHerdr(pi);

	async function split(args: string, ctx: ExtensionCommandContext, tab: boolean): Promise<void> {
		const ui = ctx.ui;
		if (ctx.mode !== "tui") {
			ui.notify("Session splitting requires interactive mode.", "error");
			return;
		}
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID?.trim()) {
			ui.notify("Run this command inside a Herdr pane.", "error");
			return;
		}
		if (!ctx.isIdle()) {
			ui.notify("Wait until Pi is idle before splitting.", "error");
			return;
		}
		if (!ctx.model) {
			ui.notify("No model selected.", "error");
			return;
		}

		// Capture all context reads before the first await. Pi forks the saved history at startup.
		const cwd = ctx.cwd;
		const sessionId = ctx.sessionManager.getSessionId();
		const modelId = `${ctx.model.provider}/${ctx.model.id}`;
		const thinkingLevel = pi.getThinkingLevel();
		const task = args.trim();
		const name = generateName(ctx, task);

		try {
			const { paneId, tabId } = tab ? await herdr.tab(cwd) : await herdr.split(cwd);
			await herdr.startPi({
				paneId,
				agentName: `split-${randomBytes(13).toString("hex")}`,
				sessionId,
				modelId,
				thinkingLevel,
			});
			if (task) await herdr.prompt(paneId, task);
			void name.then(async (generated) => {
				if (!generated) return;
				await herdr.renameAgent(paneId, generated);
				if (tabId) await herdr.renameTab(tabId, generated);
			}).catch(() => { });
		} catch (error) {
			ui.notify(`Split failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("split", {
		description: "Copy the saved session into a right-hand Herdr pane, optionally with a task",
		handler: (args, ctx) => split(args, ctx, false),
	});
	pi.registerCommand("split-tab", {
		description: "Copy the saved session into a new Herdr tab, optionally with a task",
		handler: (args, ctx) => split(args, ctx, true),
	});
}
