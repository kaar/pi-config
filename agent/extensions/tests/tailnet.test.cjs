// Run with: node --test agent/extensions/tests/tailnet.test.cjs
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("../node_modules/typescript");

const source = readFileSync(join(__dirname, "../tailnet.ts"), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(flag) {
	const handlers = new Map();
	const tools = new Map();
	const statuses = [];
	const notifications = [];
	const children = [];
	const timers = new Set();
	const executions = [];
	const createTool = (name) => (_cwd, options) => ({
		name,
		async execute() {
			const backend = options ? "remote" : "local";
			executions.push({ name, backend });
			return { backend, operations: options?.operations };
		},
	});
	const api = {
		registerFlag() {},
		getFlag: () => flag,
		registerTool: (tool) => tools.set(tool.name, tool),
		on: (name, handler) => handlers.set(name, handler),
	};
	const ctx = {
		ui: {
			theme: { fg: (color, text) => `${color}:${text}` },
			setStatus: (key, text) => statuses.push({ key, text }),
			notify: (text, level) => notifications.push({ text, level }),
		},
	};
	const exports = {};
	runInNewContext(compiled, {
		exports,
		Buffer,
		process,
		setTimeout(callback, ms) {
			const timer = { callback, ms };
			timers.add(timer);
			return timer;
		},
		clearTimeout: (timer) => timers.delete(timer),
		require(name) {
			if (name === "node:fs") return { existsSync: () => false };
			if (name === "node:child_process") {
				return {
					spawn(command, args) {
						const child = new EventEmitter();
						child.command = command;
						child.args = args;
						child.stdout = new EventEmitter();
						child.stderr = new EventEmitter();
						child.kill = (signal) => { child.killedWith = signal; };
						child.finish = (code, stdout = "", stderr = "") => {
							child.stdout.emit("data", Buffer.from(stdout));
							child.stderr.emit("data", Buffer.from(stderr));
							child.emit("close", code);
						};
						children.push(child);
						return child;
					},
				};
			}
			assert.equal(name, "@earendil-works/pi-coding-agent");
			return {
				createReadTool: createTool("read"),
				createWriteTool: createTool("write"),
				createEditTool: createTool("edit"),
				createBashTool: createTool("bash"),
			};
		},
	});
	exports.default(api);
	return {
		handlers, tools, statuses, notifications, children, timers, executions,
		start: () => handlers.get("session_start")({}, ctx),
		setFlag: (value) => { flag = value; },
	};
}

async function assertBlocked(h, pattern) {
	const executions = h.executions.length;
	const children = h.children.length;
	for (const tool of h.tools.values()) {
		await assert.rejects(tool.execute("id", {}), pattern);
	}
	for (const excludeFromContext of [false, true]) {
		const response = h.handlers.get("user_bash")({ command: "touch local-file", excludeFromContext });
		assert.equal(response.result.exitCode, 1);
		assert.match(response.result.output, pattern);
		assert.equal(response.operations, undefined);
	}
	assert.equal(h.executions.length, executions);
	assert.equal(h.children.length, children);
}

test("without --tailnet, tools and user commands retain local behavior", async () => {
	const h = harness(undefined);
	await h.start();
	assert.equal(h.children.length, 0);
	assert.equal(h.statuses.at(-1).text, undefined);
	for (const tool of h.tools.values()) assert.equal((await tool.execute()).backend, "local");
	assert.equal(h.handlers.get("user_bash")({}), undefined);
});

for (const [target, command, cwd] of [
	["user@host", "pwd", "/home/user"],
	["user@host:/root", "cd -- '/root' && pwd", "/root"],
	["user@host:project:one", "cd -- 'project:one' && pwd", "/home/user/project:one"],
	["user@host:/tmp/it's $HOME", "cd -- '/tmp/it'\\''s $HOME' && pwd", "/tmp/it's $HOME"],
]) {
	test(`validates ${target} before enabling remote tools`, async () => {
		const h = harness(target);
		await assertBlocked(h, /not ready/);
		const started = h.start();
		assert.equal(h.statuses.at(-1).text, `warning:Tailnet checking: ${target}`);
		await assertBlocked(h, /not ready/);
		assert.equal(h.children[0].command, "tailscale");
		assert.deepEqual(Array.from(h.children[0].args), ["ssh", "user@host", command]);
		h.children[0].finish(0, `${cwd}\n`);
		await started;
		assert.equal(h.statuses.at(-1).text, `accent:Tailnet: user@host:${cwd}`);
		assert.equal(h.timers.size, 0);
		for (const tool of h.tools.values()) assert.equal((await tool.execute()).backend, "remote");
		assert.ok(h.handlers.get("user_bash")({}).operations);
		const prompt = await h.handlers.get("before_agent_start")({
			systemPrompt: `Current working directory: ${process.cwd()}`,
		});
		assert.match(prompt.systemPrompt, /via Tailscale SSH: user@host/);
	});
}

for (const reason of ["unknown user", "Permission denied", "host unreachable", "cd: /root: No such file or directory"]) {
	test(`startup failure reports ${reason} and blocks local fallback`, async () => {
		const h = harness("unknown@server:/root");
		const started = h.start();
		h.children[0].finish(255, "", reason);
		await started;
		assert.equal(h.statuses.at(-1).text, "error:Tailnet unavailable: unknown@server:/root");
		assert.equal(h.notifications.at(-1).level, "error");
		assert.ok(h.notifications.at(-1).text.includes(reason));
		assert.equal(h.timers.size, 0);
		await assertBlocked(h, /Tailnet unavailable/);
		const prompt = await h.handlers.get("before_agent_start")({ systemPrompt: "original" });
		assert.match(prompt.systemPrompt, /Local execution is disabled/);
	});
}

test("startup timeout kills SSH and reports failure without waiting for close", async () => {
	const h = harness("user@offline:/root");
	const started = h.start();
	const [timer] = h.timers;
	assert.equal(timer.ms, 15_000);
	timer.callback();
	await started;
	assert.equal(h.children[0].killedWith, "SIGKILL");
	assert.match(h.notifications.at(-1).text, /timed out after 15s/);
	await assertBlocked(h, /timed out/);
	h.children[0].finish(null);
	assert.equal(h.timers.size, 0);
});

test("missing Tailscale executable reports an error and clears the timer", async () => {
	const h = harness("user@host");
	const started = h.start();
	h.children[0].emit("error", new Error("spawn tailscale ENOENT"));
	await started;
	assert.equal(h.timers.size, 0);
	await assertBlocked(h, /ENOENT/);
});

test("session startup clears stale success and permits recovery after a failed check", async () => {
	const h = harness("user@host:/root");
	let started = h.start();
	h.children.at(-1).finish(0, "/root\n");
	await started;
	started = h.start();
	await assertBlocked(h, /not ready/);
	h.children.at(-1).finish(255, "", "Permission denied");
	await started;
	await assertBlocked(h, /Permission denied/);
	started = h.start();
	h.children.at(-1).finish(0, "/root\n");
	await started;
	assert.equal((await h.tools.get("write").execute()).backend, "remote");
	h.setFlag(undefined);
	await h.start();
	assert.equal((await h.tools.get("write").execute()).backend, "local");
	assert.equal(h.statuses.at(-1).text, undefined);
});

for (const target of ["", ":/root", "user@host:", "-invalid"]) {
	test(`invalid target ${JSON.stringify(target)} fails closed without spawning SSH`, async () => {
		const h = harness(target);
		await h.start();
		assert.equal(h.children.length, 0);
		await assertBlocked(h, /Invalid --tailnet target/);
	});
}

test("empty or non-absolute pwd output is rejected", async () => {
	for (const output of ["", "relative\n"]) {
		const h = harness("user@host");
		const started = h.start();
		h.children[0].finish(0, output);
		await started;
		await assertBlocked(h, /absolute working directory/);
	}
});
