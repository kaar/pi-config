// Run from the repository root: node --test agent/extensions/herdr/herdr.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { before, after, describe, it, mock } = require("node:test");
const ts = require("typescript");

// Never import a session, credentials, or model service from the running agent.
// Load the pinned installed implementation, not the older development dependency.
const runtimePath = path.resolve(__dirname, "../../install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-split-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let runtime;
before(async () => {
	process.env.PI_CODING_AGENT_DIR = path.join(root, "isolated-agent");
	runtime = await import(pathToFileURL(runtimePath).href);
});
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});
const compiled = new Map(["index", "session", "cli"].map((name) => [name, ts.transpileModule(
	fs.readFileSync(path.join(__dirname, `${name}.ts`), "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));
const environment = {
	HERDR_ENV: "1", HERDR_PANE_ID: "old-workspace:caller-alias",
	HERDR_WORKSPACE_ID: "stale-workspace", HERDR_BIN_PATH: "/custom bin/herdr",
};
const destination = "live-workspace:destination";
const liveWorkspace = "live-workspace";
const sourceModel = Object.freeze({ provider: "source", id: "org/model:variant" });
const success = (result) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const fail = (stderr) => ({ code: 1, stdout: "", stderr });
const deferred = () => Promise.withResolvers();
const settle = () => new Promise(setImmediate);
// JSONL omits undefined optional properties, exactly like Pi's own persistence.
const persisted = (value) => JSON.parse(JSON.stringify(value));
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text, textSignature: "opaque-signature" }],
	api: "test-api", provider: "source", model: "org/model:variant", responseId: "fabricated-response",
	providerThinkingLevel: "opaque-level", thinkingLevel: "high", usage, stopReason: "stop", timestamp: 2 });
function response(args) {
	if (args[1] === "split") return success({ pane: { pane_id: destination } });
	if (args[1] === "current") return success({ pane: { pane_id: "new-caller-id", workspace_id: liveWorkspace } });
	if (args[1] === "create") return success({ root_pane: { pane_id: destination }, tab: { tab_id: "returned-tab" } });
	return success({ agent: { pane_id: destination, interactive_ready: true } });
}

function setup(options = {}) {
	const directory = fs.mkdtempSync(path.join(root, "fixture-"));
	const cwd = path.join(directory, "project with spaces café 日本語 'quotes' $(nothing)");
	const sessionDir = path.join(directory, "custom sessions λ 'quoted' ;");
	const session = options.session?.(cwd, sessionDir) ?? runtime.SessionManager.create(cwd, sessionDir);
	if (!options.empty && !options.session) {
		session.appendModelChange(sourceModel.provider, sourceModel.id);
		session.appendThinkingLevelChange("high");
		session.appendMessage(user("First requirement"));
		session.appendMessage(assistant("First response"));
	}
	const commands = new Map();
	const listeners = new Map();
	const notifications = [];
	const events = [];
	const allocations = [];
	const writes = [];
	const drafts = [];
	const api = {
		registerCommand: (name, definition) => commands.set(name, definition),
		registerTool: () => assert.fail("No cloning tools may be registered"),
		on: (name, handler) => {
			const handlers = listeners.get(name) ?? [];
			handlers.push(handler);
			listeners.set(name, handlers);
		},
		getThinkingLevel: mock.fn(() => "medium"),
		exec: mock.fn(async (binary, args) => {
			events.push(args[1]);
			return options.exec ? options.exec(binary, Array.from(args)) : response(args);
		}),
		sendMessage: () => assert.fail("Source must not receive conversation messages"),
		sendUserMessage: () => assert.fail("Source must not receive prompts"),
	};
	const readonly = Object.fromEntries(["getSessionId", "getSessionFile", "getSessionDir", "getHeader", "getLeafId"].map((name) => [name, () => session[name]() ]));
	readonly.getBranch = mock.fn(() => { events.push("capture"); return session.getBranch(); });
	const ctx = {
		mode: "tui", hasUI: true, cwd, model: sourceModel, thinkingLevel: "high", sessionManager: readonly,
		waitForIdle: mock.fn(async () => { events.push("idle"); await options.idle?.(); }),
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			setEditorText: (text) => { drafts.push(text); },
			getEditorText: () => "Original unsent draft",
		},
	};
	const dependencies = {
		"node:crypto": crypto,
		"node:fs": { writeFileSync(file, jsonl, settings) {
			writes.push({ file, settings: structuredClone(settings) });
			events.push("write");
			if (options.write) return options.write(file, jsonl, settings);
			fs.writeFileSync(file, jsonl, settings);
		} },
		"@earendil-works/pi-coding-agent": { SessionManager: { create(...args) {
			if (options.allocate) return options.allocate(...args);
			const manager = runtime.SessionManager.create(...args);
			allocations.push(manager);
			return manager;
		} } },
	};
	const cache = new Map();
	function load(name) {
		if (cache.has(name)) return cache.get(name);
		const exports = {};
		cache.set(name, exports);
		vm.runInNewContext(compiled.get(name), {
			exports, process: { env: options.env ?? { ...environment } }, Error, AbortController,
			require(specifier) {
				if (specifier.startsWith("./")) {
					assert.ok(compiled.has(specifier.slice(2)), `Unexpected local import: ${specifier}`);
					return load(specifier.slice(2));
				}
				assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected import: ${specifier}`);
				return dependencies[specifier];
			},
		}, { filename: path.join(__dirname, `${name}.ts`) });
		return exports;
	}
	load("index").default(api);
	return {
		api, ctx, session, cwd, sessionDir, notifications, events, allocations, writes, drafts, commands,
		run: (args = "", command = "split") => commands.get(command).handler(args, ctx),
		emit: async (name) => { for (const handler of listeners.get(name) ?? []) await handler({ type: name }, ctx); },
		calls: () => api.exec.mock.calls.map(({ arguments: [binary, args] }) => ({ binary, args: Array.from(args) })),
		child: (index = 0) => runtime.SessionManager.open(allocations[index].getSessionFile()),
	};
}
function snapshot(h) {
	const file = h.session.getSessionFile();
	return {
		id: h.session.getSessionId(), file, header: structuredClone(h.session.getHeader()),
		leaf: h.session.getLeafId(), branch: structuredClone(h.session.getBranch()), entries: structuredClone(h.session.getEntries()),
		bytes: file && fs.existsSync(file) ? fs.readFileSync(file) : undefined,
		model: h.ctx.model, thinking: h.ctx.thinkingLevel, cwd: h.ctx.cwd,
	};
}
function unchanged(h, original) {
	assert.deepEqual(snapshot(h), original);
	assert.deepEqual(h.drafts, []);
	assert.equal(h.ctx.ui.getEditorText(), "Original unsent draft");
	assert.ok(h.calls().every(({ args }) => !["focus", "send-text", "send-keys", "close", "run", "wait", "read"].includes(args[1])));
}
function error(h, pattern) {
	assert.equal(h.notifications.at(-1).level, "error");
	assert.match(h.notifications.at(-1).text, pattern);
}
function notLaunched(h) {
	assert.deepEqual(h.calls(), []);
	assert.deepEqual(h.allocations, []);
	assert.deepEqual(h.writes, []);
}

describe("commands and launch contract", { timeout: 5000 }, () => {
	it("registers only the two slash commands", () => {
		const h = setup();
		assert.deepEqual([...h.commands.keys()], ["split", "split-tab"]);
	});
	for (const command of ["split", "split-tab"]) {
		for (const task of ["", " \n\t ", "  Create a report café 日本語 'quoted' $(nothing); & |\nsecond line  ", "--wait --literal"]) {
			it(`${command} launches with literal arguments and task ${JSON.stringify(task)}`, async () => {
				let h;
				h = setup({ exec: async (binary, args) => {
					// Persistence must precede every layout operation.
					assert.ok(fs.existsSync(h.allocations[0].getSessionFile()));
					assert.equal(binary, environment.HERDR_BIN_PATH);
					return response(args);
				} });
				const original = snapshot(h);
				await h.run(task, command);
				const file = h.allocations[0].getSessionFile();
				const calls = h.calls();
				const layout = command === "split" ? [
					["pane", "split", "--current", "--direction", "right", "--cwd", h.cwd, "--no-focus"],
				] : [
					["pane", "current", "--current"],
					["tab", "create", "--workspace", liveWorkspace, "--cwd", h.cwd, "--no-focus"],
				];
				assert.deepEqual(calls.slice(0, layout.length).map(({ args }) => args), layout);
				const start = calls[layout.length].args;
				assert.match(start[2], /^split-[a-f0-9]{26}$/);
				assert.equal(start[2].length, 32);
				assert.deepEqual(start, ["agent", "start", start[2], "--kind", "pi", "--pane", destination, "--",
					"--session", file, "--session-dir", h.sessionDir, "--model", "source/org/model:variant", "--thinking", "high"]);
				assert.deepEqual(calls.slice(layout.length + 1).map(({ args }) => args), task.trim() ? [["agent", "prompt", destination, task.trim()]] : []);
				assert.deepEqual(h.events, ["idle", "capture", "write", ...layout.map((args) => args[1]), "start", ...(task.trim() ? ["prompt"] : [])]);
				assert.deepEqual(h.notifications, [{ level: "info", text: `Split ready in pane ${destination}. Child session: ${file}` }]);
				assert.equal(h.api.getThinkingLevel.mock.callCount(), 0);
				assert.equal(fs.statSync(file).mode & 0o777, 0o600);
				unchanged(h, original);
			});
		}
	}
	it("does not derive a workspace from the moved pane ID or inherited workspace", async () => {
		const h = setup();
		await h.run("", "split-tab");
		assert.deepEqual(h.calls()[0].args, ["pane", "current", "--current"]);
		assert.equal(h.calls()[1].args[3], liveWorkspace);
		assert.notEqual(h.calls()[1].args[3], environment.HERDR_WORKSPACE_ID);
	});
	for (const bin of [undefined, ""]) {
		it(`uses PATH with binary override ${JSON.stringify(bin)}`, async () => {
			const h = setup({ env: { ...environment, HERDR_BIN_PATH: bin } });
			await h.run();
			assert.ok(h.calls().every(({ binary }) => binary === "herdr"));
		});
	}
	it("waits for acknowledged startup before submitting once and does not wait for task completion", async () => {
		const started = deferred();
		const ready = deferred();
		const h = setup({ exec: async (_binary, args) => {
			if (args[1] === "start") { started.resolve(); await ready.promise; }
			return response(args);
		} });
		const running = h.run("Do work");
		await started.promise;
		assert.deepEqual(h.calls().map(({ args }) => args[1]), ["split", "start"]);
		assert.deepEqual(h.notifications, []);
		ready.resolve();
		await running;
		assert.deepEqual(h.calls().map(({ args }) => args[1]), ["split", "start", "prompt"]);
	});
});

describe("independent inherited sessions on installed Pi 1.1.0", { timeout: 5000 }, () => {
	it("clones the live leaf including the latest requirement and response, not the latest disk branch", async () => {
		const h = setup();
		h.session.appendMessage(user("Latest requirement: retain the new API"));
		const selected = h.session.appendMessage(assistant("Latest response: accepted"));
		h.session.appendMessage(user("Abandoned requirement"));
		h.session.appendMessage(assistant("Abandoned response"));
		h.session.branch(selected);
		const original = snapshot(h);
		await h.run();
		const child = h.child();
		assert.notEqual(child.getSessionId(), h.session.getSessionId());
		assert.notEqual(child.getSessionFile(), h.session.getSessionFile());
		assert.equal(child.getHeader().parentSession, h.session.getSessionFile());
		assert.deepEqual(child.getBranch(), h.session.getBranch());
		assert.equal(child.getLeafId(), selected);
		assert.match(fs.readFileSync(child.getSessionFile(), "utf8"), /Latest requirement|Latest response/);
		assert.doesNotMatch(fs.readFileSync(child.getSessionFile(), "utf8"), /Abandoned/);
		unchanged(h, original);
	});
	it("preserves compaction, context edits, tool data, provider metadata, and branch-local state", async () => {
		const h = setup();
		h.session.appendMessage({ role: "system", content: "", sections: { preamble: "Fabricated system prompt", cwd: h.cwd },
			toolsAdded: [{ name: "test", description: "Fabricated tool", parameters: { type: "object" } }], timestamp: 0 });
		const old = h.session.appendMessage(user("Obsolete history"));
		h.session.appendCompaction("Old summary", old, 100);
		const kept = h.session.appendMessage(user("Retained requirement"));
		h.session.appendMessage({ ...assistant("Tool request"), content: [
			{ type: "thinking", thinking: "Fabricated reasoning", thinkingSignature: "signature" },
			{ type: "toolCall", id: "call-1", name: "test", arguments: { unicode: "日本語" }, thoughtSignature: "thought-signature" },
		], stopReason: "toolUse" });
		const tool = h.session.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "test",
			content: [{ type: "text", text: "Raw result" }], details: { metadata: [1, "λ"] },
			isError: false, usage, nestedCalls: { complete: true, calls: [] }, timestamp: 3 });
		h.session.appendCompaction("Current summary", kept, 200, { files: ["test.ts"] }, true, usage);
		h.session.appendContextEdit(tool, { content: "Edited result" });
		const removed = h.session.appendMessage(user("Omitted from context, not raw history"));
		h.session.appendContextEdit(removed, null);
		h.session.appendCustomEntry("branch-state", { counter: 42 });
		h.session.appendCustomMessageEntry("instructions", "Custom context", false, { source: "fixture" });
		h.session.appendLabelChange(kept, "retained-label");
		h.session.appendSessionInfo("Fabricated name");
		h.session.appendUsage("fabricated", "source", "org/model:variant", usage);
		h.session.appendMessage(assistant("Latest final answer"));
		const original = snapshot(h);
		await h.run();
		const child = h.child();
		assert.deepEqual(child.getBranch(), persisted(h.session.getBranch()));
		assert.deepEqual(persisted(child.buildSessionProjection()), persisted(h.session.buildSessionProjection()));
		assert.deepEqual(child.buildSessionContext(), h.session.buildSessionContext());
		assert.equal(child.getBranch().filter((entry) => entry.type === "compaction").at(-1).systemMessage.sections.preamble, "Fabricated system prompt");
		assert.match(JSON.stringify(child.buildSessionProjection().messages), /Current summary|Edited result|Latest final answer/);
		assert.doesNotMatch(JSON.stringify(child.buildSessionProjection().messages), /Obsolete history|Old summary|Raw result|Omitted from context/);
		unchanged(h, original);
	});
	it("preserves branch summaries and retain-none compaction references", async () => {
		const h = setup();
		const selected = h.session.getLeafId();
		h.session.appendMessage(user("Abandoned idea"));
		h.session.branchWithSummary(selected, "Selected path summary", { metadata: "preserved" });
		h.session.appendCompaction("Retain none", null, 100);
		h.session.appendMessage(user("New question"));
		h.session.appendMessage(assistant("New answer"));
		await h.run();
		assert.deepEqual(h.child().getBranch(), persisted(h.session.getBranch()));
		assert.deepEqual(persisted(h.child().buildSessionProjection()), persisted(h.session.buildSessionProjection()));
	});
	for (const inMemory of [false, true]) {
		it(`repeated launches are resumable, unique, and independent (${inMemory ? "in-memory" : "persisted"} source)`, async () => {
			const h = setup(inMemory ? { session: (cwd) => {
				const session = runtime.SessionManager.inMemory(cwd);
				session.appendMessage(user("Memory-only requirement"));
				session.appendMessage(assistant("Memory-only response"));
				return session;
			} } : {});
			const original = snapshot(h);
			await h.run();
			await h.run("", "split-tab");
			assert.equal(h.allocations.length, 2);
			const children = [h.child(0), h.child(1)];
			assert.notEqual(children[0].getSessionId(), children[1].getSessionId());
			assert.notEqual(children[0].getSessionFile(), children[1].getSessionFile());
			assert.notEqual(h.calls()[1].args[2], h.calls()[4].args[2]);
			for (const child of children) {
				assert.deepEqual(child.getBranch(), h.session.getBranch());
				assert.equal(child.getHeader().parentSession, h.session.getSessionFile());
				assert.equal(child.getCwd(), h.cwd);
				if (inMemory) assert.ok(child.getSessionDir().startsWith(path.join(root, "isolated-agent", "sessions")));
				else assert.equal(child.getSessionDir(), h.sessionDir);
				child.appendMessage(user("Child only"));
				child.appendMessage(assistant("Independent child append"));
				assert.deepEqual(runtime.SessionManager.open(child.getSessionFile()).getBranch(), child.getBranch());
			}
			unchanged(h, original);
		});
	}
	it("repairs parent links without changing entry IDs or source entries", async () => {
		const h = setup();
		const branch = structuredClone(h.session.getBranch());
		branch.forEach((entry) => { entry.parentId = "missing-parent"; });
		h.ctx.sessionManager.getBranch = () => branch;
		await h.run();
		const clone = h.child().getBranch();
		assert.deepEqual(clone.map(({ id }) => id), branch.map(({ id }) => id));
		assert.equal(clone[0].parentId, null);
		assert.ok(clone.slice(1).every((entry, index) => entry.parentId === clone[index].id));
		assert.ok(branch.every((entry) => entry.parentId === "missing-parent"));
	});
});

describe("idle capture and lifecycle safety", { timeout: 5000 }, () => {
	it("captures completed exchanges, current model, thinking level, and cwd after waiting", async () => {
		const idle = deferred();
		const h = setup({ idle: () => idle.promise });
		const running = h.run();
		assert.equal(h.ctx.sessionManager.getBranch.mock.callCount(), 0);
		notLaunched(h);
		h.session.appendMessage(user("Finishing requirement"));
		h.session.appendMessage(assistant("Finishing response"));
		h.ctx.model = { provider: "replacement", id: "org/replacement:free" };
		h.ctx.thinkingLevel = "max";
		h.ctx.cwd = path.join(h.cwd, "changed cwd");
		const original = snapshot(h);
		idle.resolve();
		await running;
		assert.deepEqual(h.child().getBranch(), h.session.getBranch());
		assert.equal(h.child().getCwd(), h.ctx.cwd);
		assert.equal(h.calls()[0].args[6], h.ctx.cwd);
		assert.deepEqual(h.calls()[1].args.slice(-4), ["--model", "replacement/org/replacement:free", "--thinking", "max"]);
		unchanged(h, original);
	});
	it("keeps the captured history and launch settings if source work advances during layout creation", async () => {
		let h;
		h = setup({ exec: async (_binary, args) => {
			if (args[1] === "split") {
				h.session.appendMessage(user("Later source-only work"));
				h.ctx.model = { provider: "later", id: "not-the-child-model" };
				h.ctx.thinkingLevel = "off";
				h.ctx.cwd = "/later-directory";
			}
			return response(args);
		} });
		const captured = structuredClone(h.session.getBranch());
		await h.run();
		assert.deepEqual(h.child().getBranch(), captured);
		assert.deepEqual(h.calls()[1].args.slice(-4), ["--model", "source/org/model:variant", "--thinking", "high"]);
		assert.equal(h.child().getCwd(), h.cwd);
		assert.match(JSON.stringify(h.session.getBranch()), /Later source-only work/);
	});
	it("reports wait cancellation without touching invalidated context getters", async () => {
		const idle = deferred();
		const h = setup({ idle: () => idle.promise });
		const ui = h.ctx.ui;
		let active = true;
		for (const name of ["ui", "sessionManager", "model", "thinkingLevel", "cwd"]) {
			const value = h.ctx[name];
			Object.defineProperty(h.ctx, name, { get() {
				assert.ok(active, `Disposed context getter used: ${name}`);
				return value;
			} });
		}
		const running = h.run();
		await h.emit("session_shutdown");
		active = false;
		await running;
		error(h, /Source session changed/);
		notLaunched(h);
		assert.equal(ui.getEditorText(), "Original unsent draft");
		idle.resolve();
	});
	it("falls back to the exported thinking-level getter for older contexts", async () => {
		const h = setup();
		delete h.ctx.thinkingLevel;
		await h.run();
		assert.equal(h.api.getThinkingLevel.mock.callCount(), 1);
		assert.equal(h.calls()[1].args.at(-1), "medium");
	});
	for (const event of ["session_start", "session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree", "session_tree"]) {
		it(`${event} cancels a wait immediately, ignores late work, and releases the pending request`, async () => {
			const idle = deferred();
			const h = setup({ idle: () => idle.promise });
			const original = snapshot(h);
			const running = h.run("Do not send");
			await h.emit(event);
			await running;
			error(h, /Source session changed/);
			notLaunched(h);
			unchanged(h, original);
			idle.resolve();
			await settle();
			notLaunched(h);
			await h.run();
			assert.equal(h.notifications.at(-1).level, "info");
		});
	}
	it("handles a late rejected idle promise after invalidation", async () => {
		const idle = deferred();
		const h = setup({ idle: () => idle.promise });
		const running = h.run();
		await h.emit("session_shutdown");
		await running;
		idle.reject(new Error("Disposed source"));
		await settle();
		notLaunched(h);
		assert.equal(h.notifications.length, 1);
	});
	it("detects changed source identity even without a lifecycle event", async () => {
		const idle = deferred();
		const h = setup({ idle: () => idle.promise });
		const running = h.run();
		h.session.newSession();
		idle.resolve();
		await running;
		error(h, /Source session changed/);
		notLaunched(h);
	});
	it("blocks overlapping pane and tab requests during waiting and launch", async () => {
		const idle = deferred();
		const started = deferred();
		const launch = deferred();
		const h = setup({ idle: () => idle.promise, exec: async (_bin, args) => {
			if (args[1] === "start") { started.resolve(); await launch.promise; }
			return response(args);
		} });
		const running = h.run("First task");
		await h.run("Second task", "split-tab");
		error(h, /already pending/);
		notLaunched(h);
		idle.resolve();
		await started.promise;
		await h.run("Third task", "split-tab");
		error(h, /already pending/);
		assert.equal(h.allocations.length, 1);
		launch.resolve();
		await running;
		assert.equal(h.calls().filter(({ args }) => args[1] === "prompt").length, 1);
		await h.run();
		assert.equal(h.allocations.length, 2);
	});
});

describe("unsupported inputs and partial failures", { timeout: 5000 }, () => {
	for (const mode of ["rpc", "json", "print"]) {
		it(`rejects ${mode} before waiting or allocation`, async () => {
			const h = setup();
			h.ctx.mode = mode;
			const original = snapshot(h);
			await h.run();
			error(h, /requires interactive mode/);
			assert.equal(h.ctx.waitForIdle.mock.callCount(), 0);
			notLaunched(h);
			unchanged(h, original);
		});
	}
	for (const env of [{}, { HERDR_ENV: "0", HERDR_PANE_ID: "caller" }, { HERDR_ENV: "1" }, { HERDR_ENV: "1", HERDR_PANE_ID: " \n " }]) {
		it(`rejects unsupported environment ${JSON.stringify(env)}`, async () => {
			const h = setup({ env });
			const original = snapshot(h);
			await h.run();
			error(h, /inside a Herdr pane/);
			notLaunched(h);
			assert.equal(h.ctx.waitForIdle.mock.callCount(), 0);
			unchanged(h, original);
		});
	}
	it("rejects an absent model after waiting but before cloning", async () => {
		const h = setup();
		h.ctx.model = undefined;
		const original = snapshot(h);
		await h.run();
		error(h, /No model selected/);
		notLaunched(h);
		unchanged(h, original);
	});
	for (const stateOnly of [false, true]) {
		it(`rejects ${stateOnly ? "state-only" : "empty"} history without allocation`, async () => {
			const h = setup({ empty: true });
			if (stateOnly) h.session.appendModelChange("source", "model");
			const original = snapshot(h);
			await h.run();
			error(h, /No active conversation branch/);
			notLaunched(h);
			unchanged(h, original);
		});
	}
	it("does not clone the abandoned branch when the selected leaf is empty", async () => {
		const h = setup();
		h.session.resetLeaf();
		const original = snapshot(h);
		await h.run();
		error(h, /No active conversation branch/);
		notLaunched(h);
		unchanged(h, original);
	});
	it("reports a failed idle wait and permits a later request", async () => {
		let fails = true;
		const h = setup({ idle: async () => { if (fails) throw new Error("Idle wait failed"); } });
		const original = snapshot(h);
		await h.run();
		error(h, /Idle wait failed/);
		notLaunched(h);
		unchanged(h, original);
		fails = false;
		await h.run();
		assert.equal(h.notifications.at(-1).level, "info");
	});
	it("reports session allocation errors without changing source or layout", async () => {
		const h = setup({ allocate: () => { throw new Error("Session directory unavailable"); } });
		const original = snapshot(h);
		await h.run();
		error(h, /Session directory unavailable/);
		notLaunched(h);
		unchanged(h, original);
	});
	it("reports the allocated recovery path on a write error, without layout changes", async () => {
		const h = setup({ write: () => { throw new Error("Owner-only write failed"); } });
		const original = snapshot(h);
		await h.run();
		error(h, /Owner-only write failed/);
		assert.ok(h.notifications.at(-1).text.includes(h.allocations[0].getSessionFile()));
		assert.deepEqual(h.calls(), []);
		assert.deepEqual(h.writes[0].settings, { flag: "wx", mode: 0o600 });
		unchanged(h, original);
	});
	it("exclusive creation preserves an existing file and reports the collision", async () => {
		const h = setup({ write: (file, jsonl, settings) => {
			fs.writeFileSync(file, "Existing data", { mode: 0o600 });
			fs.writeFileSync(file, jsonl, settings);
		} });
		const original = snapshot(h);
		await h.run();
		error(h, /EEXIST/);
		assert.equal(fs.readFileSync(h.allocations[0].getSessionFile(), "utf8"), "Existing data");
		assert.deepEqual(h.calls(), []);
		unchanged(h, original);
	});
	for (const command of ["split", "split-tab"]) {
		const stages = command === "split" ? ["split", "start", "prompt"] : ["current", "create", "start", "prompt"];
		for (const [index, stage] of stages.entries()) {
			for (const failure of ["exit code", "rejection", "malformed JSON", "missing identifier", "blank identifier", "wrong response field"]) {
				it(`${command} preserves partial launch on ${stage}: ${failure}`, async () => {
					let failing = true;
					const h = setup({ exec: async (_bin, args) => {
						if (failing && args[1] === stage) {
							if (failure === "exit code") return fail(stage === "start" ? "agent_not_ready: startup blocked" : "Operation failed");
							if (failure === "rejection") throw new Error("CLI unavailable");
							if (failure === "malformed JSON") return { code: 0, stdout: "{broken", stderr: "" };
							if (failure === "missing identifier") return success({});
							if (failure === "wrong response field") return success(stage === "split"
								? { root_pane: { pane_id: destination } }
								: { pane: { pane_id: destination } });
							return success({ pane: { pane_id: " ", workspace_id: " " }, root_pane: { pane_id: " " }, agent: { pane_id: " " } });
						}
						return response(args);
					} });
					const original = snapshot(h);
					await h.run("Submit once", command);
					assert.deepEqual(h.calls().map(({ args }) => args[1]), stages.slice(0, index + 1));
					error(h, /failed|unavailable|invalid|no valid/);
					const file = h.allocations[0].getSessionFile();
					assert.ok(h.notifications.at(-1).text.includes(file));
					assert.ok(fs.existsSync(file));
					assert.deepEqual(h.child().getBranch(), h.session.getBranch());
					if (["start", "prompt"].includes(stage)) assert.ok(h.notifications.at(-1).text.includes(destination));
					unchanged(h, original);
					failing = false;
					await h.run();
					assert.equal(h.notifications.at(-1).level, "info");
				});
			}
		}
	}
	for (const stage of ["start", "prompt"]) {
		it(`rejects ${stage} acknowledgment from a different pane without retry`, async () => {
			const h = setup({ exec: async (_bin, args) => args[1] === stage ? success({ agent: { pane_id: "different-pane" } }) : response(args) });
			const original = snapshot(h);
			await h.run("Task");
			error(h, /different pane ID/);
			assert.equal(h.calls().filter(({ args }) => args[1] === stage).length, 1);
			unchanged(h, original);
		});
	}
	for (const [result, detail] of [
		[{ code: 3, stdout: "stdout detail", stderr: " stderr detail\n" }, /stderr detail/],
		[{ code: 4, stdout: " stdout detail\n", stderr: " \n" }, /stdout detail/],
		[{ code: 5, stdout: "", stderr: "" }, /exit code 5/],
	]) {
		it(`reports CLI failure detail ${detail}`, async () => {
			const h = setup({ exec: async () => result });
			await h.run();
			error(h, detail);
			assert.equal(h.calls().length, 1);
		});
	}
	it("keeps a created pane and clone if source shutdown occurs during startup", async () => {
		const started = deferred();
		const ready = deferred();
		const h = setup({ exec: async (_bin, args) => {
			if (args[1] === "start") { started.resolve(); await ready.promise; }
			return response(args);
		} });
		const original = snapshot(h);
		const running = h.run("Do not deliver");
		await started.promise;
		await h.emit("session_shutdown");
		ready.resolve();
		await running;
		error(h, /Source session changed/);
		assert.ok(h.notifications.at(-1).text.includes(destination));
		assert.ok(h.notifications.at(-1).text.includes(h.allocations[0].getSessionFile()));
		assert.deepEqual(h.calls().map(({ args }) => args[1]), ["split", "start"]);
		assert.ok(fs.existsSync(h.allocations[0].getSessionFile()));
		unchanged(h, original);
	});
});
