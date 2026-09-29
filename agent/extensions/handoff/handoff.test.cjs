// Run with: node --test agent/extensions/handoff/handoff.test.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("../node_modules/typescript");

const source = readFileSync(join(__dirname, "index.ts"), "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const NOW = 1790000000000;
const MODEL = { provider: "test-provider", id: "test-model" };
const OTHER_MODEL = { provider: "other-provider", id: "org/other-model:free" };
const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/bin/herdr" };
const SPLIT_OK = { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "" };

const message = (id, role, text) => ({
	type: "message",
	id,
	message: { role, content: [{ type: "text", text }], timestamp: 1 },
});
const BRANCH = [message("m1", "user", "start the feature"), message("m2", "assistant", "planned it")];

function harness(options = {}) {
	const calls = { complete: [], exec: [], editor: [], setEditorText: [], newSession: 0, sendUserMessage: 0 };
	const notifications = [];
	const commands = new Map();
	let loader;
	const exec = { split: SPLIT_OK, start: { code: 0, stdout: "{}", stderr: "" }, send: { code: 0, stdout: "", stderr: "" }, ...options.exec };

	class BorderedLoader {
		constructor() {
			this.controller = new AbortController();
			loader = this;
		}
		get signal() {
			return this.controller.signal;
		}
		set onAbort(fn) {
			this.abort = () => {
				this.controller.abort();
				fn();
			};
		}
	}

	const api = {
		registerCommand: (name, command) => commands.set(name, command),
		sendUserMessage: () => calls.sendUserMessage++,
		async exec(command, args) {
			calls.exec.push({ command, args: Array.from(args) });
			const key = { split: "split", start: "start", "send-text": "send" }[args[1]];
			return exec[key];
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		model: "model" in options ? options.model : MODEL,
		cwd: "/work/project",
		waitForIdle: async () => options.onIdle?.(),
		newSession: async () => calls.newSession++,
		sessionManager: { getBranch: () => options.branch ?? BRANCH },
		modelRegistry: {
			complete(model, context, requestOptions) {
				calls.complete.push({ model, context, requestOptions });
				if (options.onComplete) return options.onComplete(() => loader);
				return Promise.resolve(options.response ?? { stopReason: "stop", content: [{ type: "text", text: "  Generated prompt  " }] });
			},
		},
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			custom: (factory) => new Promise((resolve) => factory({}, {}, {}, resolve)),
			editor: async (title, prefill) => {
				calls.editor.push({ title, prefill });
				options.onEditor?.();
				return "editor" in options ? options.editor : `${prefill} (edited)`;
			},
			setEditorText: (text) => calls.setEditorText.push(text),
		},
	};

	const exports = {};
	runInNewContext(compiled, {
		exports,
		process: { env: options.env ?? HERDR_ENV },
		Date: class extends Date {
			static now() {
				return NOW;
			}
		},
		require(name) {
			if (name === "@earendil-works/pi-ai") return { uuidv7: () => "session-id" };
			assert.equal(name, "@earendil-works/pi-coding-agent");
			return {
				BorderedLoader,
				convertToLlm: (messages) => messages,
				serializeConversation: (messages) => JSON.stringify(messages),
			};
		},
	});
	exports.default(api);
	const run = (args = "implement phase one") => commands.get("handoff").handler(args, ctx);
	return { calls, ctx, notifications, run };
}

function assertNoSideEffects(h) {
	assert.equal(h.calls.exec.length, 0);
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.calls.newSession, 0);
	assert.equal(h.calls.sendUserMessage, 0);
}

test("successful handoff generates, reviews, splits, starts Pi, and pastes an unsubmitted draft", async () => {
	const h = harness();
	await h.run("  implement phase one  ");

	assert.equal(h.calls.complete.length, 1);
	const [{ model, context, requestOptions }] = h.calls.complete;
	assert.equal(model, MODEL);
	assert.match(context.systemPrompt, /Output only the prompt itself/);
	const input = context.messages[0].content[0].text;
	assert.ok(input.includes(JSON.stringify(BRANCH.map((entry) => entry.message))));
	assert.ok(input.endsWith("## User's Goal for New Thread\n\nimplement phase one"));
	assert.equal(requestOptions.cacheRetention, "none");
	assert.equal(requestOptions.sessionId, "session-id");
	assert.ok(requestOptions.signal);

	assert.deepEqual(h.calls.editor, [{ title: "Edit handoff prompt", prefill: "Generated prompt" }]);
	const name = `handoff-${NOW.toString(36)}`;
	assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.deepEqual(h.calls.exec, [
		{ command: "/bin/herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", "/work/project", "--no-focus"] },
		{
			command: "/bin/herdr",
			args: ["agent", "start", name, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-provider/test-model"],
		},
		{ command: "/bin/herdr", args: ["pane", "send-text", "w1:p2", "Generated prompt (edited)"] },
	]);
	for (const { args } of h.calls.exec) {
		assert.ok(!args.includes("prompt") && !args.includes("run") && !args.includes("send-keys"));
		assert.ok(!args.some((arg) => /enter/i.test(arg)));
	}
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.calls.newSession, 0);
	assert.equal(h.calls.sendUserMessage, 0);
	assert.deepEqual(h.notifications.at(-1), {
		text: "Handoff draft ready in pane w1:p2. Review it there and press Enter to start.",
		level: "info",
	});
});

test("model selected when the source settles is used for generation and successor startup", async () => {
	const h = harness({ onIdle: () => (h.ctx.model = OTHER_MODEL) });
	await h.run();
	assert.equal(h.calls.complete[0].model, OTHER_MODEL);
	assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "other-provider/org/other-model:free"]);
});

test("model switches after invocation do not affect generation or successor startup", async () => {
	const h = harness({
		onComplete: () => {
			h.ctx.model = OTHER_MODEL;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Generated prompt" }] });
		},
		onEditor: () => (h.ctx.model = undefined),
	});
	await h.run();
	assert.equal(h.calls.complete[0].model, MODEL);
	assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "test-provider/test-model"]);
	assert.equal(h.notifications.at(-1).level, "info");
});

test("herdr defaults to the PATH binary when HERDR_BIN_PATH is unset", async () => {
	const h = harness({ env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" } });
	await h.run();
	assert.ok(h.calls.exec.every(({ command }) => command === "herdr"));
});

test("compacted branch sends the latest summary plus retained and later entries", async () => {
	const branch = [
		message("old", "user", "old work"),
		{ type: "compaction", id: "c1", summary: "first summary", tokensBefore: 10, firstKeptEntryId: "old", timestamp: "2026-01-01T00:00:00Z" },
		message("dropped", "assistant", "summarized away"),
		message("kept", "user", "kept work"),
		{ type: "model_change", id: "mc" },
		{ type: "compaction", id: "c2", summary: "latest summary", tokensBefore: 99, firstKeptEntryId: "kept", timestamp: "2026-01-02T00:00:00Z" },
		message("after", "assistant", "recent work"),
	];
	const h = harness({ branch });
	await h.run();
	const input = h.calls.complete[0].context.messages[0].content[0].text;
	const serialized = JSON.parse(input.split("\n\n")[1]);
	assert.deepEqual(serialized, [
		{ role: "compactionSummary", summary: "latest summary", tokensBefore: 99, timestamp: Date.parse("2026-01-02T00:00:00Z") },
		branch[3].message,
		branch[6].message,
	]);
});

for (const [label, options, args, pattern] of [
	["missing goal", {}, "   ", /Usage: \/handoff/],
	["non-TUI mode", { mode: "rpc" }, undefined, /requires interactive mode/],
	["missing model", { model: undefined }, undefined, /No model selected/],
	["missing HERDR_ENV", { env: { HERDR_PANE_ID: "w1:p1" } }, undefined, /inside a Herdr pane/],
	["missing HERDR_PANE_ID", { env: { HERDR_ENV: "1" } }, undefined, /inside a Herdr pane/],
	["no usable history", { branch: [{ type: "model_change", id: "mc" }] }, undefined, /No conversation/],
]) {
	test(`${label} stops before generation`, async () => {
		const h = harness(options);
		await h.run(args);
		assert.equal(h.calls.complete.length, 0);
		assert.equal(h.calls.editor.length, 0);
		assertNoSideEffects(h);
		assert.equal(h.notifications.at(-1).level, "error");
		assert.match(h.notifications.at(-1).text, pattern);
	});
}

for (const [label, options, level, pattern] of [
	["aborted response", { response: { stopReason: "aborted", content: [] } }, "info", /cancelled/],
	[
		"loader cancellation",
		{ onComplete: (getLoader) => new Promise((resolve) => setImmediate(() => { getLoader().abort(); resolve({ stopReason: "aborted", content: [] }); })) },
		"info",
		/cancelled/,
	],
	["blank response", { response: { stopReason: "stop", content: [{ type: "text", text: "  \n" }] } }, "error", /empty prompt/],
	["error response", { response: { stopReason: "error", errorMessage: "context too long", content: [] } }, "error", /context too long/],
	["rejected request", { onComplete: () => Promise.reject(new Error("network down")) }, "error", /network down/],
	["cancelled editor", { editor: undefined }, "info", /cancelled/],
	["emptied editor", { editor: "  " }, "info", /cancelled/],
]) {
	test(`${label} makes no Herdr calls`, async () => {
		const h = harness(options);
		await h.run();
		assertNoSideEffects(h);
		assert.equal(h.notifications.length, 1);
		assert.equal(h.notifications[0].level, level);
		assert.match(h.notifications[0].text, pattern);
	});
}

const failure = { code: 1, stdout: "", stderr: '{"error":{"code":"boom","message":"it broke"}}' };
for (const [label, exec, execCount, pattern] of [
	["split failure", { split: failure }, 1, /herdr pane split failed: .*it broke.*No pane was created\./],
	["invalid split JSON", { split: { code: 0, stdout: "not json", stderr: "" } }, 1, /invalid JSON.*No pane was created\./],
	["missing pane ID", { split: { code: 0, stdout: '{"result":{"pane":{}}}', stderr: "" } }, 1, /no pane ID.*No pane was created\./],
	["start failure", { start: failure }, 2, /herdr agent start failed: .*it broke.*Pane w1:p2 was created/],
	["send failure", { send: failure }, 3, /herdr pane send-text failed: .*it broke.*Pane w1:p2 was created/],
]) {
	test(`${label} restores the approved prompt and reports the error`, async () => {
		const h = harness({ exec });
		await h.run();
		assert.equal(h.calls.exec.length, execCount);
		assert.deepEqual(h.calls.setEditorText, ["Generated prompt (edited)"]);
		assert.equal(h.notifications.at(-1).level, "error");
		assert.match(h.notifications.at(-1).text, pattern);
		assert.match(h.notifications.at(-1).text, /restored to the editor/);
		assert.equal(h.calls.newSession, 0);
	});
}
