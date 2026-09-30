/**
 * Handoff extension - continue the current work in a fresh Pi session in a Herdr pane.
 *
 * Usage:
 *   /handoff implement phase one of the plan
 *
 * Generates a continuation prompt with DeepSeek V4.1 Flash through OpenRouter
 * Nitro, with reasoning disabled. Pastes the prompt into a fresh Pi session,
 * focuses its right-hand Herdr pane, and sends Pi's external-editor shortcut.
 * The new session uses the captured source model. Saving and closing the editor
 * returns to an unsubmitted draft. The source session is not changed.
 */

import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type Model = NonNullable<ExtensionCommandContext["model"]>;
type Generation =
	| { status: "ok"; text: string; externalEditorKey: string | undefined }
	| { status: "cancelled" }
	| { status: "error"; message: string };

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

function selectModelByPriceRank(scopedModels: ExtensionCommandContext["scopedModels"], score: number): Model | undefined {
	if (scopedModels.length === 0 || !Number.isFinite(score)) return undefined;
	if (scopedModels.some(({ model }) => !Number.isFinite(model.cost?.output) || model.cost.output < 0)) {
		return undefined;
	}

	// Sort a copy. Stable sorting preserves scope order for equal output prices.
	const sorted = [...scopedModels].sort((a, b) => a.model.cost.output - b.model.cost.output);
	const clampedScore = Math.max(0, Math.min(3, score));
	const index = Math.round((clampedScore / 3) * (sorted.length - 1));
	return sorted[index].model;
}

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

// After compaction, the active context is the latest summary plus the entries kept from firstKeptEntryId.
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	let entries = branch;
	if (compactionIndex >= 0) {
		const compaction = branch[compactionIndex];
		const firstKeptIndex =
			compaction.type === "compaction" ? branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId) : -1;
		entries = [
			compaction,
			...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
			...branch.slice(compactionIndex + 1),
		];
	}
	return entries.map(entryToMessage).filter((message) => message !== undefined);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function generatePrompt(
	ctx: ExtensionCommandContext,
	model: Model,
	conversationText: string,
	goal: string,
): Promise<Generation> {
	return ctx.ui.custom<Generation>((tui, theme, keybindings, done) => {
		const externalEditorKey = keybindings.getKeys("app.editor.external")[0];
		let finished = false;
		const finish = (result: Generation) => {
			if (finished) return;
			finished = true;
			done(result);
		};
		const loader = new BorderedLoader(tui, theme, "Generating handoff with DeepSeek V4.1 Flash (Nitro)...");
		loader.onAbort = () => finish({ status: "cancelled" });

		const userMessage: Message = {
			role: "user",
			content: [
				{
					type: "text",
					text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
				},
			],
			timestamp: Date.now(),
		};
		ctx.modelRegistry
			.complete(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{
					signal: loader.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
					onPayload: (payload: unknown) => ({
						...(payload as Record<string, unknown>),
						reasoning: { enabled: false },
					}),
				},
			)
			.then((response) => {
				if (response.stopReason === "aborted") return finish({ status: "cancelled" });
				if (response.stopReason === "error") {
					return finish({ status: "error", message: response.errorMessage || "model request failed" });
				}
				const text = response.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();
				finish(text ? { status: "ok", text, externalEditorKey } : { status: "error", message: "model returned an empty prompt" });
			})
			.catch((error) => finish({ status: "error", message: errorText(error) }));

		return loader;
	});
}

async function herdr(pi: ExtensionAPI, args: string[]): Promise<string> {
	const result = await pi.exec(process.env.HERDR_BIN_PATH || "herdr", args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`herdr ${args[0]} ${args[1]} failed: ${detail}`);
	}
	return result.stdout;
}

function parsePaneId(stdout: string): string {
	let paneId: unknown;
	try {
		paneId = JSON.parse(stdout)?.result?.pane?.pane_id;
	} catch {
		throw new Error("herdr pane split returned invalid JSON");
	}
	if (typeof paneId !== "string" || !paneId) throw new Error("herdr pane split returned no pane ID");
	return paneId;
}

async function launchSuccessor(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	modelRef: string,
	prompt: string,
	externalEditorKey: string | undefined,
): Promise<void> {
	let paneId: string | undefined;
	try {
		paneId = parsePaneId(
			await herdr(pi, ["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd, "--no-focus"]),
		);
		// agent start returns once the new Pi editor is ready; send-text pastes without pressing Enter.
		const name = `handoff-${Date.now().toString(36)}`;
		await herdr(pi, ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", "--model", modelRef]);
		await herdr(pi, ["pane", "send-text", paneId, prompt]);
	} catch (error) {
		ctx.ui.setEditorText(prompt);
		const pane = paneId
			? `Pane ${paneId} was created; inspect or close it manually.`
			: "No pane was created.";
		ctx.ui.notify(`Handoff failed: ${errorText(error)}. ${pane} The prompt was restored to the editor.`, "error");
		return;
	}

	// The destination now owns the draft. UI failures must not restore a duplicate in the source.
	try {
		await herdr(pi, ["agent", "focus", paneId]);
	} catch (error) {
		ctx.ui.notify(
			`Handoff draft transferred to pane ${paneId}, but focus failed: ${errorText(error)}. Select that pane and open Pi's external editor manually.`,
			"warning",
		);
		return;
	}
	if (!externalEditorKey) {
		ctx.ui.notify(
			`Handoff draft transferred to pane ${paneId}. Automatic editor opening is unavailable because app.editor.external has no binding. Review the draft in Pi, then press Enter.`,
			"warning",
		);
		return;
	}
	try {
		await herdr(pi, ["agent", "send-keys", paneId, externalEditorKey]);
	} catch (error) {
		ctx.ui.notify(
			`Handoff draft transferred to pane ${paneId}, but external-editor shortcut delivery failed: ${errorText(error)}. Review the draft in that pane manually.`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(
		`Handoff draft transferred to pane ${paneId}. External-editor shortcut sent. Save and close the editor, then press Enter in Pi.`,
		"info",
	);
}

export default function (pi: ExtensionAPI) {
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
			// Capture the selection once so later model switches in this session do not affect the handoff.
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}
			const modelRef = `${model.provider}/${model.id}`;
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("No conversation to hand off", "error");
				return;
			}
			const conversationText = serializeConversation(convertToLlm(messages));

			const baseGenerator = ctx.modelRegistry.find("openrouter", "deepseek/deepseek-v4.1-flash");
			if (!baseGenerator) {
				ctx.ui.notify(
					"Handoff requires openrouter/deepseek/deepseek-v4.1-flash. Run `pi update --models`, then reload Pi.",
					"error",
				);
				return;
			}
			const generator = { ...baseGenerator, id: `${baseGenerator.id}:nitro` };
			const generation = await generatePrompt(ctx, generator, conversationText, goal);
			if (generation.status === "cancelled") {
				ctx.ui.notify("Handoff cancelled", "info");
				return;
			}
			if (generation.status === "error") {
				ctx.ui.notify(`Handoff prompt generation failed: ${generation.message}`, "error");
				return;
			}

			await launchSuccessor(pi, ctx, modelRef, generation.text, generation.externalEditorKey);
		},
	});
}
