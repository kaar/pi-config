// Adapted from https://github.com/polo871209/dotfiles/blob/main/.pi/agent/extensions/fork-window.ts
import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DRAFT_ENTRY = "PI_REX_FORK_DRAFT_ENTRY";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const entryId = process.env[DRAFT_ENTRY];
		if (!entryId) return;
		delete process.env[DRAFT_ENTRY];

		// Recover the draft from the parent session rather than passing prompt text to Rex.
		const source = ctx.sessionManager.getHeader()?.parentSession;
		if (!source || !existsSync(source)) return;
		const entry = SessionManager.open(source).getEntry(entryId);
		if (entry?.type !== "message" || entry.message.role !== "user") return;
		const { content } = entry.message;
		ctx.ui.setEditorText(
			typeof content === "string"
				? content
				: content.map((part) => (part.type === "text" ? part.text : "")).join(""),
		);
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const rexSession = process.env.REX_SESSION;
		if (!rexSession || ctx.mode !== "tui") return;

		const source = ctx.sessionManager.getSessionFile();
		const entry = ctx.sessionManager.getEntry(event.entryId);
		if (!source || !existsSync(source) || !entry) return;

		const isFork = event.position === "before";
		const leafId = isFork ? entry.parentId : entry.id;
		if (!leafId) return;

		// Branch a separate manager so the current Pi keeps its session.
		const copy = SessionManager.open(source, ctx.sessionManager.getSessionDir());
		const file = copy.createBranchedSession(leafId);
		if (!file || !existsSync(file)) return;
		const name = (pi.getSessionName() ?? basename(ctx.cwd)).replace(/^(fork|clone): /, "");
		copy.appendSessionInfo(`${isFork ? "fork" : "clone"}: ${name}`);

		const options = { cwd: ctx.cwd, timeout: 15_000 };
		const command = ["pi", "--session", file];
		if (isFork) command.unshift("env", `${DRAFT_ENTRY}=${entry.id}`);
		const opened = await pi.exec(
			"rex",
			["window", "new", "-s", rexSession, "-c", ctx.cwd, "--json", "--", ...command],
			options,
		);
		if (opened.code !== 0) {
			rmSync(file, { force: true });
			const error = opened.stderr.trim() || opened.stdout.trim() || `exit code ${opened.code}`;
			ctx.ui.notify(`Could not open a Rex tab: ${error}. Continuing in this pane.`, "error");
			return;
		}

		let windowId: unknown;
		try {
			windowId = JSON.parse(opened.stdout)?.window_id;
		} catch {
			// The tab is already open. Do not create a second branch in this pane.
		}
		if (typeof windowId !== "string" || !windowId) {
			ctx.ui.notify("Rex opened the tab but did not return a window ID to select.", "warning");
			return { cancel: true };
		}

		// Rex.app needs a client action to switch the visible tab.
		const selected = await pi.exec(
			"rex",
			["do", "-s", rexSession, "session.select", `session_id=${rexSession}`, `window_id=${windowId}`],
			options,
		);
		if (selected.code !== 0) {
			const error = selected.stderr.trim() || selected.stdout.trim() || `exit code ${selected.code}`;
			ctx.ui.notify(`Rex opened the tab but could not switch to it: ${error}`, "warning");
		}
		return { cancel: true };
	});
}
