import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PaneInfo = { pane: { workspace_id: string } };
type TabInfo = { root_pane: { pane_id: string }; tab: { tab_id: string }; };

interface PiLaunchOptions {
	pane: string;
	name: string;
	model: string;
	thinking: string;
	fork?: string;
}

export interface Herdr {
	tabCreate(cwd: string): Promise<{ paneId: string; tabId: string }>;
	tabRename(tabId: string, name: string): Promise<void>;
	agentStartPi(options: PiLaunchOptions): Promise<void>;
	agentPrompt(paneId: string, text: string): Promise<void>;
	agentRename(paneId: string, name: string): Promise<void>;
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

	async function query<T>(args: string[]): Promise<T> {
		const stdout = await run(args);
		try {
			return JSON.parse(stdout).result as T;
		} catch (cause) {
			throw new Error(`herdr ${args[0]} ${args[1]} returned invalid JSON.`, { cause });
		}
	}

	return {
		async tabCreate(cwd: string): Promise<{ paneId: string; tabId: string }> {
			const paneInfo = await query<PaneInfo>(["pane", "current", "--current"]);
			const workspaceId = paneInfo.pane.workspace_id;
			const tabInfo = await query<TabInfo>(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--no-focus"]);
			return {
				paneId: tabInfo.root_pane.pane_id,
				tabId: tabInfo.tab.tab_id,
			};
		},
		async tabRename(tabId: string, name: string): Promise<void> {
			await run(["tab", "rename", tabId, name]);
		},
		async agentStartPi(options: PiLaunchOptions): Promise<void> {
			const args = [
				"agent", "start", options.name,
				"--kind", "pi",
				"--pane", options.pane,
				"--",
				"--model", options.model,
				"--thinking", options.thinking,
			];
			if (options.fork !== undefined) args.push("--fork", options.fork);
			await run(args);
		},
		async agentPrompt(paneId: string, task: string): Promise<void> {
			await run(["agent", "prompt", paneId, task]);
		},
		async agentRename(paneId: string, name: string): Promise<void> {
			await run(["agent", "rename", paneId, name]);
		},
	};
}
