/**
 * Thin typed wrapper around the herdr CLI.
 *
 * Each method runs one herdr command and throws on failure.
 * Callers decide how to handle errors (notify, fall back, restore state).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type Direction = "left" | "right" | "up" | "down";

export interface Herdr {
	/** Split the current pane without focusing the new one. Returns the new pane ID. */
	splitPane(direction: Direction, cwd: string): Promise<string>;
	/** Start Pi with a model in a pane. Resolves once the Pi editor is ready. */
	startPiAgent(paneId: string, name: string, model: string): Promise<void>;
	/** Paste text into a pane without pressing Enter. */
	sendText(paneId: string, text: string): Promise<void>;
	/** Send a key sequence to the agent in a pane. */
	sendKeys(paneId: string, keys: string): Promise<void>;
	/** Focus the agent in a pane. */
	focusAgent(paneId: string): Promise<void>;
}

export function createHerdr(pi: ExtensionAPI): Herdr {
	const bin = process.env.HERDR_BIN_PATH || "herdr";

	async function run(args: string[]): Promise<string> {
		const result = await pi.exec(bin, args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`herdr ${args[0]} ${args[1]} failed: ${detail}`);
		}
		return result.stdout;
	}

	return {
		async splitPane(direction, cwd) {
			// --no-focus keeps focus in the source until the draft has arrived. The caller focuses afterwards.
			return parsePaneId(await run(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus"]));
		},

		async startPiAgent(paneId, name, model) {
			await run(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", "--model", model]);
		},

		async sendText(paneId, text) {
			await run(["pane", "send-text", paneId, text]);
		},

		async sendKeys(paneId, keys) {
			await run(["agent", "send-keys", paneId, keys]);
		},

		async focusAgent(paneId) {
			await run(["agent", "focus", paneId]);
		},
	};
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
