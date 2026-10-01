/**
 * Handoff extension - continue the current work in a fresh Pi session in a Herdr pane.
 *
 * Usage:
 *   /handoff implement phase one of the plan
 *
 * Generates a continuation prompt with DeepSeek V4.1 Flash through OpenRouter,
 * with reasoning disabled. Starts Pi with the source model in a new right-hand
 * Herdr pane, pastes the prompt, focuses the pane, and sends Pi's
 * external-editor shortcut. Saving and closing the editor returns to an
 * unsubmitted draft. If the launch fails, the prompt is restored to the source
 * editor. The source session is not changed.
 */

import { type TextContent, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { createHerdr, type Herdr } from "./herdr";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, write a focused prompt that starts a fresh coding agent session.

The prompt must:
1. Summarize the relevant context: what was being worked on, decisions made, approaches taken, and key findings
2. List the relevant files that were discussed or modified
3. Describe the current state, including anything unfinished or known to be broken
4. State the next task clearly, based on the user's goal
5. Be self-contained, so the new session can proceed without the old conversation

Be concise but include all necessary context. Output only the prompt itself, with no preamble such as "Here's the prompt".

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Current state
[What is done and what is not]

## Task
[Clear description of what to do next based on the user's goal]`;

async function createHandoffPrompt(
	ctx: ExtensionContext,
	goal: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!goal.trim()) throw new Error("Goal must not be empty");
	if (signal?.aborted) throw new Error("Prompt generation aborted");

	const model = ctx.modelRegistry.find("openrouter", "deepseek/deepseek-v4.1-flash");
	if (!model) throw new Error("openrouter/deepseek/deepseek-v4.1-flash not found. Run `pi update --models`, then reload Pi");

	const { messages } = ctx.sessionManager.buildSessionProjection();
	const conversation = serializeConversation(convertToLlm(messages));
	if (!conversation.trim()) throw new Error("Conversation must not be empty");

	const response = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: `## Conversation History\n\n${conversation}\n\n## User's Goal for New Thread\n\n${goal}`,
				}],
				timestamp: Date.now(),
			}],
		},
		{
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
			onPayload: (payload: unknown) => ({
				...(payload as Record<string, unknown>),
				reasoning: { enabled: false },
			}),
		},
	);

	if (response.stopReason === "aborted") throw new Error("Prompt generation aborted");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "Model request failed");

	const prompt = response.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!prompt) throw new Error("Model returned an empty prompt");
	return prompt;
}

async function launchSuccessor(herdr: Herdr, cwd: string, modelRef: string, prompt: string): Promise<string> {
	const paneId = await herdr.splitPane("right", cwd);
	await herdr.startPiAgent(paneId, `handoff-${Date.now().toString(36)}`, modelRef);
	await herdr.sendText(paneId, prompt);
	// TODO: Could be replace by removing --no-focus?
	await herdr.focusAgent(paneId);
	await herdr.sendKeys(paneId, "ctrl+g");
	return paneId;
}

/** Run a task behind a cancellable loader. Resolves undefined on cancel. */
async function withLoader<T>(
	ctx: ExtensionCommandContext,
	label: string,
	task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
	let result!: Promise<T>;
	const finished = await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, label);
		loader.onAbort = () => done(false);
		result = task(loader.signal);
		result.then(() => done(true), () => done(true));
		return loader;
	});
	return finished ? result : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function(pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "Continue this work in a fresh Pi session in a new Herdr pane",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}
			if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
				ctx.ui.notify("handoff requires Pi to run inside a Herdr pane", "error");
				return;
			}

			await ctx.waitForIdle();
			// Read the model after the source settles, so the successor uses the current one.
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const modelRef = `${model.provider}/${model.id}`;
			let handoffPrompt: string | undefined;
			try {
				handoffPrompt = await withLoader(ctx, "Generating handoff prompt...", (signal) =>
					createHandoffPrompt(ctx, goal, signal));
				if (!handoffPrompt) return;
				const paneId = await launchSuccessor(createHerdr(pi), ctx.cwd, modelRef, handoffPrompt);
				ctx.ui.notify(
					`Handoff draft sent to pane ${paneId}. Save and close the editor, then press Enter in Pi.`,
					"info",
				);
			} catch (error) {
				if (handoffPrompt) ctx.ui.setEditorText(handoffPrompt);
				const restored = handoffPrompt ? " The prompt was restored to the editor." : "";
				ctx.ui.notify(`Handoff failed: ${errorText(error)}.${restored}`, "error");
			}
		},
	});
}
