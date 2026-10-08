import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HerdrResult<T> = { result: T };
type Pane = HerdrResult<{ pane: { pane_id: string; workspace_id: string } }>;
type Tab = HerdrResult<{ root_pane: { pane_id: string }; tab: { tab_id: string } }>;

interface Destination {
	paneId: string;
	tabId?: string;
}

interface PiLaunchOptions {
	paneId: string;
	agentName: string;
	sessionId: string;
	modelId: string;
	thinkingLevel: string;
}

export function createHerdr(pi: ExtensionAPI) {
	const bin = process.env.HERDR_BIN_PATH || "herdr";

	async function run<T = unknown>(args: string[]): Promise<T> {
		const operation = `herdr ${args[0]} ${args[1]}`;
		const result = await pi.exec(bin, args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`${operation} failed: ${detail}`);
		}
		try {
			return JSON.parse(result.stdout) as T;
		} catch {
			throw new Error(`${operation} returned invalid JSON.`);
		}
	}

	return {
		async split(cwd: string): Promise<Destination> {
			const pane = await run<Pane>(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]);
			return { paneId: pane.result.pane.pane_id };
		},
		async tab(cwd: string): Promise<Destination> {
			// --current resolves inherited pane aliases after a cross-workspace move.
			const pane = await run<Pane>(["pane", "current", "--current"]);
			const tab = await run<Tab>(["tab", "create", "--workspace", pane.result.pane.workspace_id, "--cwd", cwd, "--no-focus"]);
			return {
				paneId: tab.result.root_pane.pane_id,
				// Tab metadata is only for optional naming, never a startup requirement.
				tabId: tab.result.tab?.tab_id,
			};
		},
		async startPi(options: PiLaunchOptions): Promise<void> {
			await run([
				"agent", "start", options.agentName,
				"--kind", "pi",
				"--pane", options.paneId,
				"--",
				"--fork", options.sessionId,
				"--model", options.modelId,
				"--thinking", options.thinkingLevel,
			]);
		},
		async prompt(paneId: string, task: string): Promise<void> {
			await run(["agent", "prompt", paneId, task]);
		},
		async renameAgent(paneId: string, name: string): Promise<void> {
			await run(["agent", "rename", paneId, name]);
		},
		async renameTab(tabId: string, name: string): Promise<void> {
			await run(["tab", "rename", tabId, name]);
		},
	};
}
