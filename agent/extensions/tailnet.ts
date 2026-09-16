/**
 * Tailscale SSH Remote Execution
 *
 * Delegates tool operations to a remote machine via Tailscale SSH.
 * When --tailnet is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi --tailnet user@host
 *   pi --tailnet user@host:/remote/path
 *
 * Requirements:
 *   - Tailscale installed and connected to the tailnet
 *   - Tailscale SSH enabled on the remote
 *   - bash on the remote
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const MACOS_TAILSCALE_PATH = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const TAILSCALE_COMMAND = existsSync(MACOS_TAILSCALE_PATH) ? MACOS_TAILSCALE_PATH : "tailscale";

const CONNECTION_TIMEOUT_MS = 15_000;

function sshExec(remote: string, command: string, timeoutMs?: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(TAILSCALE_COMMAND, ["ssh", remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		const timer = timeoutMs
			? setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`Tailscale SSH timed out after ${timeoutMs / 1000}s: ${Buffer.concat(errChunks).toString()}`));
				}, timeoutMs)
			: undefined;
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`Tailscale SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn(TAILSCALE_COMMAND, ["ssh", remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("tailnet", { description: "Tailscale SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;

	let sshError: string | null = null;

	const getSshError = () =>
		!resolvedSsh && pi.getFlag("tailnet") !== undefined
			? sshError ?? "Tailnet connection is not ready. Local execution is disabled."
			: null;

	const getSsh = () => {
		const error = getSshError();
		if (error) throw new Error(error);
		return resolvedSsh;
	};

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, _ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = pi.getFlag("tailnet") as string | undefined;
		resolvedSsh = null;
		sshError = null;
		if (arg === undefined) {
			ctx.ui.setStatus("tailnet", undefined);
			return;
		}

		ctx.ui.setStatus("tailnet", ctx.ui.theme.fg("warning", `Tailnet checking: ${arg}`));
		try {
			const separator = arg.indexOf(":");
			const remote = separator < 0 ? arg : arg.slice(0, separator);
			const path = separator < 0 ? undefined : arg.slice(separator + 1);
			if (!remote || remote.startsWith("-") || path === "") {
				throw new Error("Invalid --tailnet target. Use user@host or user@host:/path.");
			}
			// Enter the directory to check access and resolve relative paths on the remote.
			const command = path === undefined ? "pwd" : `cd -- '${path.replaceAll("'", "'\\''")}' && pwd`;
			const remoteCwd = (await sshExec(remote, command, CONNECTION_TIMEOUT_MS)).toString().trim();
			if (!remoteCwd.startsWith("/")) {
				throw new Error("Tailscale SSH did not return an absolute working directory.");
			}
			resolvedSsh = { remote, remoteCwd };
			ctx.ui.setStatus("tailnet", ctx.ui.theme.fg("accent", `Tailnet: ${remote}:${remoteCwd}`));
			ctx.ui.notify(`Tailnet mode: ${remote}:${remoteCwd}`, "info");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			sshError = `Tailnet unavailable: ${arg}\n${reason}\nLocal execution is disabled. Fix the target or connection, then reload or restart pi.`;
			ctx.ui.setStatus("tailnet", ctx.ui.theme.fg("error", `Tailnet unavailable: ${arg}`));
			ctx.ui.notify(sshError, "error");
		}
	});

	// Handle user ! commands via Tailscale SSH
	pi.on("user_bash", (_event) => {
		const error = getSshError();
		// Return a failed result. Throwing from this event can fall back to local execution.
		if (error) {
			return { result: { output: error, exitCode: 1, cancelled: false, truncated: false } };
		}
		const ssh = getSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const error = getSshError();
		if (error) return { systemPrompt: `${event.systemPrompt}\n\n${error}` };
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via Tailscale SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
