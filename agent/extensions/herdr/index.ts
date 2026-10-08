import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createHerdr } from "./cli";
import { captureChild, persistChild, type ChildSession } from "./session";

type SessionSource = ExtensionCommandContext["sessionManager"];

function createLaunchRequest(source: SessionSource) {
	const sessionId = source.getSessionId();
	const sessionFile = source.getSessionFile();
	const controller = new AbortController();

	const invalidated = new Promise<void>((resolve) => {
		controller.signal.addEventListener("abort", () => resolve(), {
			once: true,
		});
	});

	return {
		invalidated,

		invalidate() {
			controller.abort();
		},

		assertValid() {
			if (
				controller.signal.aborted
				|| source.getSessionId() !== sessionId
				|| source.getSessionFile() !== sessionFile
			) {
				throw new Error(
					"Source session changed, navigated, or shut down. Split stopped.",
				);
			}
		},
	};
}

export default function (pi: ExtensionAPI) {
	const herdr = createHerdr(pi);
	let pending: ReturnType<typeof createLaunchRequest> | undefined;

	// Navigation is tracked explicitly. Ordinary appends during finishing work are allowed.
	const invalidate = () => { pending?.invalidate(); };
	pi.on("session_start", invalidate);
	pi.on("session_shutdown", invalidate);
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("session_tree", invalidate);

	async function split(args: string, ctx: ExtensionCommandContext, tab: boolean): Promise<void> {
		// Context getters become invalid on runtime shutdown. Keep the notification surface.
		const ui = ctx.ui;
		if (pending) {
			ui.notify("A split launch is already pending.", "error");
			return;
		}
		if (ctx.mode !== "tui") {
			ui.notify("Session splitting requires interactive mode.", "error");
			return;
		}
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID?.trim()) {
			ui.notify("Run this command inside a Herdr pane.", "error");
			return;
		}

		const source = ctx.sessionManager;
		const request = createLaunchRequest(source);
		pending = request;
		let child: ChildSession | undefined;
		let pane: string | undefined;
		try {
			// Racing invalidation also releases the command if an old runtime never becomes idle.
			await Promise.race([ctx.waitForIdle(), request.invalidated]);
			request.assertValid();
			const model = ctx.model;
			if (!model) throw new Error("No model selected.");
			const modelId = `${model.provider}/${model.id}`;
			const thinking = ctx.thinkingLevel ?? pi.getThinkingLevel();
			const cwd = ctx.cwd;
			const task = args.trim();
			child = captureChild(source, cwd);
			persistChild(child);

			if (tab) {
				const workspace = await herdr.workspace();
				request.assertValid();
				pane = await herdr.tab(workspace, cwd);
			} else {
				pane = await herdr.split(cwd);
			}
			request.assertValid();
			await herdr.startPi({
				paneId: pane,
				agentName: `split-${randomBytes(13).toString("hex")}`,
				sessionFile: child.file,
				sessionDirectory: child.directory,
				modelId,
				thinkingLevel: thinking,
			});
			request.assertValid();
			if (task) await herdr.prompt(pane, task);
			request.assertValid();
			ui.notify(`Split ready in pane ${pane}. Child session: ${child.file}`, "info");
		} catch (error) {
			const recovery = [
				pane ? `Pane: ${pane}.` : "",
				child ? `Child session: ${child.file}.` : "",
			].filter(Boolean).join(" ");
			ui.notify(`Split failed: ${error instanceof Error ? error.message : String(error)}${recovery ? ` ${recovery}` : ""}`, "error");
		} finally {
			if (pending === request) pending = undefined;
		}
	}

	pi.registerCommand("split", {
		description: "Copy the active conversation into a right-hand Herdr pane, optionally with a task",
		handler: (args, ctx) => split(args, ctx, false),
	});
	pi.registerCommand("split-tab", {
		description: "Copy the active conversation into a new Herdr tab, optionally with a task",
		handler: (args, ctx) => split(args, ctx, true),
	});
}
