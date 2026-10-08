// Run from the repository root: node --test agent/extensions/herdr/herdr.test.cjs
// Herdr, Pi startup, and model requests are all fabricated. Nothing is launched or contacted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { describe, it } = require("node:test");
const ts = require("typescript");

const modules = Object.fromEntries(["index", "cli", "naming"].map((name) => {
	const source = fs.readFileSync(path.join(__dirname, `${name}.ts`), "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	return [name, vm.compileFunction(outputText, ["exports", "require", "process", "AbortSignal"], { filename: `${name}.ts` })];
}));

/** Load a local module with injected globals. Local imports share one module cache. */
function load(name, { env = {}, abortSignal = AbortSignal } = {}) {
	const cache = {};
	const localRequire = (specifier) => {
		if (!specifier.startsWith("./")) return require(specifier);
		const local = specifier.slice(2);
		if (!cache[local]) {
			cache[local] = {};
			modules[local](cache[local], localRequire, { env }, abortSignal);
		}
		return cache[local];
	};
	return localRequire(`./${name}`);
}

const ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w:1", HERDR_BIN_PATH: "/opt/herdr" };
const NAMER = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" };
const ok = (result) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const reply = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra });
const settle = () => new Promise(setImmediate);

/** The context fields naming reads. Records each model request. */
function namingContext(messages, requests, complete, namer = NAMER) {
	return {
		sessionManager: { buildSessionProjection: () => ({ messages }) },
		modelRegistry: {
			find: (...args) => { assert.deepEqual(args, [NAMER.provider, NAMER.id]); return namer ?? undefined; },
			complete: (...args) => { requests.push(args); return complete(...args); },
		},
	};
}

function herdr(args) {
	switch (`${args[0]} ${args[1]}`) {
		case "pane split": return ok({ pane: { pane_id: "w:2" } });
		case "pane current": return ok({ pane: { pane_id: "w:1", workspace_id: "w" } });
		case "tab create": return ok({ root_pane: { pane_id: "w:2" }, tab: { tab_id: "w:t2" } });
		case "agent start": return ok({ agent: { pane_id: args[6] } });
		case "agent prompt": return ok({ agent: { pane_id: args[2] } });
		default: return ok({});
	}
}

function setup({ env = ENV, exec = herdr, complete = async () => reply("Fix Login Bug"), namer = NAMER, messages = [] } = {}) {
	const calls = [];
	const notes = [];
	const requests = [];
	const commands = new Map();
	const pi = {
		registerCommand: (name, definition) => commands.set(name, definition.handler),
		getThinkingLevel: () => "high",
		exec: async (bin, args) => {
			assert.equal(bin, env.HERDR_BIN_PATH || "herdr");
			calls.push(args);
			return exec(args);
		},
	};
	const ctx = {
		...namingContext(messages, requests, complete, namer),
		mode: "tui",
		cwd: "/work dir",
		model: { provider: "src", id: "org/model" },
		isIdle: () => true,
		ui: { notify: (text, level) => notes.push([level, text]) },
	};
	ctx.sessionManager.getSessionId = () => "session-1";
	load("index", { env }).default(pi);
	return {
		pi, ctx, calls, notes, requests, commands,
		run: (args, command = "split") => commands.get(command)(args, ctx),
		renames: () => calls.filter((args) => args[1] === "rename"),
	};
}

const startArgs = (pane, agent, model = "src/org/model", thinking = "high") =>
	["agent", "start", agent, "--kind", "pi", "--pane", pane, "--", "--fork", "session-1", "--model", model, "--thinking", thinking];

describe("commands", () => {
	it("registers /split and /split-tab", () => {
		assert.deepEqual([...setup().commands.keys()], ["split", "split-tab"]);
	});

	const guards = [
		["non-interactive mode", { ctx: { mode: "rpc" } }, /requires interactive mode/],
		["outside Herdr", { env: {} }, /inside a Herdr pane/],
		["blank pane ID", { env: { ...ENV, HERDR_PANE_ID: " " } }, /inside a Herdr pane/],
		["busy session", { ctx: { isIdle: () => false } }, /Wait until Pi is idle/],
		["no model", { ctx: { model: undefined } }, /No model selected/],
	];
	for (const [label, { env, ctx }, message] of guards) {
		it(`rejects ${label} before any Herdr call`, async () => {
			const h = setup(env && { env });
			Object.assign(h.ctx, ctx);
			await h.run("task");
			assert.deepEqual(h.calls, []);
			assert.deepEqual(h.requests, []);
			assert.equal(h.notes.length, 1);
			assert.equal(h.notes[0][0], "error");
			assert.match(h.notes[0][1], message);
		});
	}
});

describe("launch", () => {
	it("/split opens a right-hand pane, forks the session, and submits the trimmed task", async () => {
		const h = setup();
		await h.run("  fix the login bug \n");
		await settle();
		const agent = h.calls[1][2];
		assert.match(agent, /^split-[0-9a-f]{26}$/);
		assert.deepEqual(h.calls, [
			["pane", "split", "--current", "--direction", "right", "--cwd", "/work dir", "--no-focus"],
			startArgs("w:2", agent),
			["agent", "prompt", "w:2", "fix the login bug"],
			["agent", "rename", "w:2", "fix-login-bug"],
		]);
		assert.deepEqual(h.notes, []);
	});

	it("/split-tab opens a tab in the live workspace and leaves the child waiting without a task", async () => {
		const h = setup({ env: { ...ENV, HERDR_BIN_PATH: "" } });
		await h.run("", "split-tab");
		await settle();
		assert.deepEqual(h.calls, [
			["pane", "current", "--current"],
			["tab", "create", "--workspace", "w", "--cwd", "/work dir", "--no-focus"],
			startArgs("w:2", h.calls[2][2]),
			["agent", "rename", "w:2", "fix-login-bug"],
			["tab", "rename", "w:t2", "fix-login-bug"],
		]);
		assert.deepEqual(h.notes, []);
	});

	it("uses context captured before the first await", async () => {
		const layout = Promise.withResolvers();
		const h = setup({ exec: async (args) => { if (args[1] === "split") await layout.promise; return herdr(args); } });
		const running = h.run("");
		Object.assign(h.ctx, { cwd: "/later", model: { provider: "later", id: "model" } });
		h.pi.getThinkingLevel = () => "off";
		layout.resolve();
		await running;
		assert.equal(h.calls[0][6], "/work dir");
		assert.deepEqual(h.calls[1], startArgs("w:2", h.calls[1][2]));
	});
});

describe("failures", () => {
	const cases = [
		["exit code with stderr", "split", "pane split", { code: 1, stdout: "out", stderr: " boom\n" }, "herdr pane split failed: boom"],
		["exit code with stdout only", "split", "pane split", { code: 3, stdout: " out\n", stderr: "" }, "herdr pane split failed: out"],
		["exit code without output", "split-tab", "pane current", { code: 4, stdout: "", stderr: "" }, "herdr pane current failed: exit code 4"],
		["invalid JSON", "split-tab", "tab create", { code: 0, stdout: "{", stderr: "" }, "herdr tab create returned invalid JSON."],
		["prompt failure", "split", "agent prompt", { code: 1, stdout: "", stderr: "agent_not_ready" }, "herdr agent prompt failed: agent_not_ready"],
	];
	for (const [label, command, stage, result, message] of cases) {
		it(`stops at ${stage} on ${label} and skips naming`, async () => {
			const h = setup({ exec: (args) => `${args[0]} ${args[1]}` === stage ? result : herdr(args) });
			await h.run("task", command);
			await settle();
			assert.equal(h.calls.map((args) => `${args[0]} ${args[1]}`).at(-1), stage);
			assert.deepEqual(h.notes, [["error", `Split failed: ${message}`]]);
		});
	}

	it("ignores rename failures", async () => {
		const h = setup({ exec: (args) => args[1] === "rename" ? { code: 1, stdout: "", stderr: "conflict" } : herdr(args) });
		await h.run("task", "split-tab");
		await settle();
		assert.equal(h.renames().length, 1);
		assert.deepEqual(h.notes, []);
	});
});

describe("naming", () => {
	it("sends only bounded task text and the last assistant text to the naming model", async () => {
		const h = setup({
			messages: [
				{ role: "user", content: [{ type: "text", text: "secret user" }] },
				reply("secret old reply"),
				{ role: "toolResult", content: [{ type: "text", text: "secret file" }] },
				{ role: "assistant", content: [
					{ type: "thinking", thinking: "secret thinking" },
					{ type: "text", text: "a".repeat(1500) },
					{ type: "toolCall", name: "read", arguments: { path: "secret" } },
				] },
			],
		});
		await h.run("t".repeat(3000));
		const [model, context, options] = h.requests[0];
		assert.equal(model, NAMER);
		assert.equal(context.messages.length, 1);
		assert.deepEqual(JSON.parse(context.messages[0].content[0].text), { task: "t".repeat(2000), lastResponse: "a".repeat(1000) });
		assert.doesNotMatch(JSON.stringify(context), /secret/);
		assert.equal(options.maxTokens, 64);
		assert.equal(options.cacheRetention, "none");
		assert.notEqual(options.sessionId, "session-1");
		assert.deepEqual(options.onPayload({ x: 1, reasoning: { enabled: true } }), { x: 1, reasoning: { enabled: false } });
	});

	it("renames only the agent when the tab ID is missing", async () => {
		const h = setup({ exec: (args) => args[1] === "create" ? ok({ root_pane: { pane_id: "w:2" } }) : herdr(args) });
		await h.run("", "split-tab");
		await settle();
		assert.deepEqual(h.renames(), [["agent", "rename", "w:2", "fix-login-bug"]]);
	});

	const unavailable = [
		["no naming model", { namer: null }],
		["request rejection", { complete: async () => { throw new Error("offline"); } }],
		["error response", { complete: async () => reply("Name", { stopReason: "error" }) }],
		["unusable name", { complete: async () => reply("123 日本語") }],
	];
	for (const [label, options] of unavailable) {
		it(`keeps the initial name silently on ${label}`, async () => {
			const h = setup(options);
			await h.run("task", "split-tab");
			await settle();
			assert.deepEqual(h.renames(), []);
			assert.deepEqual(h.notes, []);
		});
	}

	it("gives up at the deadline even if the provider ignores the abort", async () => {
		const deadline = new AbortController();
		const abortSignal = { timeout: (ms) => { assert.equal(ms, 10_000); return deadline.signal; } };
		const requests = [];
		const { generateName } = load("naming", { abortSignal });
		const name = generateName(namingContext([], requests, () => new Promise(() => {})), "task");
		assert.equal(requests[0][2].signal, deadline.signal);
		deadline.abort();
		assert.equal(await name, undefined);
	});

	it("normalizes model output to a short dash-separated name", () => {
		const { normalizeName } = load("naming");
		for (const [output, expected] of [
			["`Fix API__Routing!!!`", "fix-api-routing"],
			["  Café / Tools  ", "caf-tools"],
			["a".repeat(31) + "-more", "a".repeat(31)],
			["a".repeat(40), "a".repeat(32)],
			["123-first", undefined],
			["", undefined],
		]) assert.equal(normalizeName(output), expected, output);
	});
});
