import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHerdr } from "./cli";
import { generateHandoffPrompt, generateName } from "./openrouter";

type HerdrContext = {
	cwd: string;
	sessionId: string;
	modelId: string;
	thinkingLevel: string;
};

export default function(pi: ExtensionAPI) {
	const herdr = createHerdr(pi);

	function prepareContext(ctx: ExtensionCommandContext): HerdrContext | undefined {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("This command requires interactive mode.", "error");
			return;
		}
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID?.trim()) {
			ctx.ui.notify("Run this command inside a Herdr pane.", "error");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait until Pi is idle before running this command.", "error");
			return;
		}
		if (!ctx.model) {
			ctx.ui.notify("No model selected.", "error");
			return;
		}
		return {
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
			modelId: `${ctx.model.provider}/${ctx.model.id}`,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	async function createHandoffSession(context: HerdrContext) {
		const { paneId, tabId } = await herdr.tabCreate(context.cwd);
		await herdr.agentStartPi({
			pane: paneId,
			name: `handoff-${randomBytes(12).toString("hex")}`,
			model: context.modelId,
			thinking: context.thinkingLevel,
		});
		return { tabId, paneId };
	}

	async function createForkSession(context: HerdrContext) {
		const { paneId, tabId } = await herdr.tabCreate(context.cwd);
		await herdr.agentStartPi({
			pane: paneId,
			name: `fork-${randomBytes(13).toString("hex")}`,
			model: context.modelId,
			thinking: context.thinkingLevel,
			fork: context.sessionId,
		});
		return { paneId, tabId };
	}

	async function renameSessionBackground(
		ctx: ExtensionCommandContext,
		session: { tabId: string; paneId: string },
		task: string,
	): Promise<void> {
		try {
			const name = await generateName(ctx, task);
			await herdr.agentRename(session.paneId, name);
			await herdr.tabRename(session.tabId, name);
		} catch (error) {
			ctx.ui.notify(`Automatic session naming failed: ${error}`, "warning");
		}
	}

	async function fork(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const context = prepareContext(ctx);
		if (!context) return;
		const task = args.trim();

		try {
			const session = await createForkSession(context);
			void renameSessionBackground(ctx, session, task);
			if (task) await herdr.agentPrompt(session.paneId, task);
		} catch (error) {
			ctx.ui.notify(`Fork failed: ${error}`, "error");
		}
	}


	async function handoff(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const context = prepareContext(ctx);
		if (!context) return;
		const goal = args.trim() ||
			"Preserve the current context, decisions, and agreed next steps, then wait for my instructions.";

		try {
			const session = await createHandoffSession(context);
			void renameSessionBackground(ctx, session, goal);
			const prompt = await generateHandoffPrompt(ctx, goal);
			await herdr.agentPrompt(session.paneId, prompt);
		} catch (error) {
			ctx.ui.notify(`Handoff failed: ${error}`, "error");
		}
	}

	pi.registerCommand("herdr-handoff", {
		description: "Continue this work in a fresh Pi session in a new Herdr tab",
		handler: handoff,
	});
	pi.registerCommand("herdr-fork", {
		description: "Fork the saved session into a new Herdr tab, optionally with a task",
		handler: fork,
	});
}
