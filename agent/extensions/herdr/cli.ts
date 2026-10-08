import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface PiLaunchOptions {
	paneId: string;
	agentName: string;
	sessionFile: string;
	sessionDirectory: string;
	modelId: string;
	thinkingLevel: string;
}

export function createHerdr(pi: ExtensionAPI) {
	const bin = process.env.HERDR_BIN_PATH || "herdr";

	async function run(args: string[]): Promise<unknown> {
		const operation = `herdr ${args[0]} ${args[1]}`;
		const result = await pi.exec(bin, args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`${operation} failed: ${detail}`);
		}
		try {
			return JSON.parse(result.stdout);
		} catch {
			throw new Error(`${operation} returned invalid JSON.`);
		}
	}

	return {
		async split(cwd: string): Promise<string> {
			return identifier(await run(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]),
				["result", "pane", "pane_id"], "pane split");
		},
		async workspace(): Promise<string> {
			// --current resolves inherited pane aliases after a cross-workspace move.
			return identifier(await run(["pane", "current", "--current"]),
				["result", "pane", "workspace_id"], "pane current");
		},
		async tab(workspace: string, cwd: string): Promise<string> {
			return identifier(await run(["tab", "create", "--workspace", workspace, "--cwd", cwd, "--no-focus"]),
				["result", "root_pane", "pane_id"], "tab create");
		},
		async startPi(options: PiLaunchOptions): Promise<void> {
			const response = await run([
				"agent", "start", options.agentName,
				"--kind", "pi",
				"--pane", options.paneId,
				"--",
				"--session", options.sessionFile,
				"--session-dir", options.sessionDirectory,
				"--model", options.modelId,
				"--thinking", options.thinkingLevel,
			]);
			checkAgent(response, options.paneId, "agent start");
		},
		async prompt(pane: string, task: string): Promise<void> {
			checkAgent(await run(["agent", "prompt", pane, task]), pane, "agent prompt");
		},
	};
}

function identifier(response: unknown, keys: string[], operation: string): string {
	let value = response;
	for (const key of keys) {
		value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
	}
	if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\s\x00-\x1f\x7f]/u.test(value)) {
		throw new Error(`herdr ${operation} returned no valid ${keys.at(-1)}.`);
	}
	return value;
}

function checkAgent(response: unknown, pane: string, operation: string): void {
	if (identifier(response, ["result", "agent", "pane_id"], operation) !== pane) {
		throw new Error(`herdr ${operation} returned a different pane ID.`);
	}
}
