import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type HerdrResult<T> = { result: T };
type Pane = HerdrResult<{ pane: { pane_id: string; workspace_id: string } }>;
type Tab = HerdrResult<{ root_pane: { pane_id: string }; tab: { tab_id: string } }>;

interface Destination {
	paneId: string;
	tabId?: string;
}

interface PiLaunchOptions {
	pane: string;
	name: string;
	model: string;
	thinking: string;
	fork?: string;
}

export interface Herdr {
	paneSplit(cwd: string): Promise<Destination>;
	paneSendText(paneId: string, text: string): Promise<void>;
	tabCreate(cwd: string): Promise<Destination>;
	tabRename(tabId: string, name: string): Promise<void>;
	agentStartPi(options: PiLaunchOptions): Promise<void>;
	agentPrompt(paneId: string, text: string): Promise<void>;
	agentRename(paneId: string, name: string): Promise<void>;
	agentFocus(paneId: string): Promise<void>;
	agentSendKeys(paneId: string, key: string): Promise<void>;
}

export function createHerdr(pi: ExtensionAPI): Herdr {
	const bin = process.env.HERDR_BIN_PATH || "herdr";

	async function run<T = unknown>(args: string[]): Promise<T> {
		const result = await pi.exec(bin, args);
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`herdr ${args[0]} ${args[1]} failed: ${detail}`);
		}
		try {
			return JSON.parse(result.stdout) as T;
		} catch (cause) {
			throw new Error(`herdr ${args[0]} ${args[1]} returned invalid JSON.`, { cause });
		}
	}

	return {
		async paneSplit(cwd: string): Promise<Destination> {
			const pane = await run<Pane>(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]);
			return { paneId: pane.result.pane.pane_id };
		},
		async paneSendText(paneId: string, text: string): Promise<void> {
			await run(["pane", "send-text", paneId, text]);
		},
		async tabCreate(cwd: string): Promise<Destination> {
			// --current resolves inherited pane aliases after a cross-workspace move.
			const pane = await run<Pane>(["pane", "current", "--current"]);
			const tab = await run<Tab>(["tab", "create", "--workspace", pane.result.pane.workspace_id, "--cwd", cwd, "--no-focus"]);
			return {
				paneId: tab.result.root_pane.pane_id,
				// Tab metadata is only for optional naming, never a startup requirement.
				tabId: tab.result.tab?.tab_id,
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
		async agentFocus(paneId: string): Promise<void> {
			await run(["agent", "focus", paneId]);
		},
		async agentSendKeys(paneId: string, key: string): Promise<void> {
			await run(["agent", "send-keys", paneId, key]);
		},
	};
}
