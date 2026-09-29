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
const GENERATOR = Object.freeze({
	provider: "openrouter",
	id: "deepseek/deepseek-v4.1-flash",
	api: "openai-completions",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	contextWindow: 1048576,
	maxTokens: 65536,
	compat: Object.freeze({ thinkingFormat: "openrouter" }),
});
const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/bin/herdr" };
const SPLIT_OK = { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }), stderr: "" };

const message = (id, role, text) => ({
	type: "message",
	id,
	message: { role, content: [{ type: "text", text }], timestamp: 1 },
});
const BRANCH = [message("m1", "user", "start the feature"), message("m2", "assistant", "planned it")];

function harness(options = {}) {
	const calls = { find: [], complete: [], getKeys: [], loaderLabels: [], exec: [], editor: [], setEditorText: [], newSession: 0, sendUserMessage: 0 };
	const notifications = [];
	const commands = new Map();
	let loader;
	const ok = { code: 0, stdout: "", stderr: "" };
	const exec = { split: SPLIT_OK, start: ok, send: ok, focus: ok, keys: ok, ...options.exec };
	const externalKeys = options.externalKeys ?? ["ctrl+g"];

	class BorderedLoader {
		constructor(_tui, _theme, label) {
			calls.loaderLabels.push(label);
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
			const key = { split: "split", start: "start", "send-text": "send", focus: "focus", "send-keys": "keys" }[args[1]];
			await options.onExec?.(key);
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
			find(provider, id) {
				calls.find.push({ provider, id });
				return "generator" in options ? options.generator : GENERATOR;
			},
			complete(model, context, requestOptions) {
				calls.complete.push({ model, context, requestOptions });
				if (options.onComplete) return options.onComplete(() => loader);
				return Promise.resolve(options.response ?? { stopReason: "stop", content: [{ type: "text", text: "  Generated prompt  " }] });
			},
		},
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			custom: (factory) => new Promise((resolve) => factory({}, {}, {
				getKeys: (action) => {
					calls.getKeys.push(action);
					return externalKeys;
				},
			}, resolve)),
			editor: async (title, prefill) => {
				calls.editor.push({ title, prefill });
				throw new Error("Source review must not open");
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
	const run = async (args = "implement phase one") => {
		await commands.get("handoff").handler(args, ctx);
		assert.deepEqual(calls.editor, []);
		assert.equal(calls.newSession, 0);
		assert.equal(calls.sendUserMessage, 0);
		for (const { args } of calls.exec) {
			assert.ok(!["prompt", "run"].includes(args[1]), "must not submit a prompt");
			if (args[1] === "send-keys") {
				assert.deepEqual(args, ["agent", "send-keys", "w1:p2", externalKeys[0]]);
				assert.ok(!args.slice(3).some((key) => /^(enter|return)$/i.test(key)));
			}
		}
	};
	return { calls, ctx, notifications, run };
}

function assertNoSideEffects(h) {
	assert.equal(h.calls.exec.length, 0);
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.calls.newSession, 0);
	assert.equal(h.calls.sendUserMessage, 0);
}

test("successful handoff generates, pastes, focuses, and sends only the external-editor shortcut", async () => {
	const h = harness();
	await h.run("  implement phase one  ");

	assert.equal(h.calls.complete.length, 1);
	const [{ model, context, requestOptions }] = h.calls.complete;
	assert.deepEqual(h.calls.find, [{ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" }]);
	assert.notEqual(model, GENERATOR);
	assert.deepEqual({ ...model }, { ...GENERATOR, id: "deepseek/deepseek-v4.1-flash:nitro" });
	assert.equal(GENERATOR.id, "deepseek/deepseek-v4.1-flash");
	assert.deepEqual(GENERATOR.compat, { thinkingFormat: "openrouter" });
	assert.equal(h.ctx.model, MODEL);
	assert.deepEqual(h.ctx.sessionManager.getBranch(), BRANCH);
	assert.deepEqual(h.calls.loaderLabels, ["Generating handoff with DeepSeek V4.1 Flash (Nitro)..."]);
	assert.match(context.systemPrompt, /Output only the prompt itself/);
	const input = context.messages[0].content[0].text;
	assert.ok(input.includes(JSON.stringify(BRANCH.map((entry) => entry.message))));
	assert.ok(input.endsWith("## User's Goal for New Thread\n\nimplement phase one"));
	assert.equal(requestOptions.cacheRetention, "none");
	assert.equal(requestOptions.sessionId, "session-id");
	assert.ok(requestOptions.signal);

	assert.deepEqual(h.calls.editor, []);
	assert.deepEqual(h.calls.getKeys, ["app.editor.external"]);
	const name = `handoff-${NOW.toString(36)}`;
	assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.deepEqual(h.calls.exec, [
		{ command: "/bin/herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", "/work/project", "--no-focus"] },
		{
			command: "/bin/herdr",
			args: ["agent", "start", name, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "test-provider/test-model"],
		},
		{ command: "/bin/herdr", args: ["pane", "send-text", "w1:p2", "Generated prompt"] },
		{ command: "/bin/herdr", args: ["agent", "focus", "w1:p2"] },
		{ command: "/bin/herdr", args: ["agent", "send-keys", "w1:p2", "ctrl+g"] },
	]);
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.calls.newSession, 0);
	assert.equal(h.calls.sendUserMessage, 0);
	assert.deepEqual(h.notifications.at(-1), {
		text: "Handoff draft transferred to pane w1:p2. External-editor shortcut sent. Save and close the editor, then press Enter in Pi.",
		level: "info",
	});
});

test("each Herdr command completes before the next command starts", async () => {
	let pending = false;
	const completed = [];
	const h = harness({
		onExec: async (key) => {
			assert.equal(pending, false);
			pending = true;
			await new Promise(setImmediate);
			completed.push(key);
			pending = false;
		},
	});
	await h.run();
	assert.deepEqual(completed, ["split", "start", "send", "focus", "keys"]);
	assert.equal(pending, false);
	assert.equal(h.notifications.at(-1).level, "info");
});

test("first configured external-editor shortcut replaces ctrl+g", async () => {
	const h = harness({ externalKeys: ["ctrl+shift+e", "alt+e"] });
	await h.run();
	assert.equal(h.calls.exec.length, 5);
	assert.deepEqual(h.calls.exec[4].args, ["agent", "send-keys", "w1:p2", "ctrl+shift+e"]);
	assert.equal(h.calls.setEditorText.length, 0);
});

test("disabled external-editor binding preserves transfer and focus without sending keys", async () => {
	const h = harness({ externalKeys: [] });
	await h.run();
	assert.deepEqual(h.calls.exec.map(({ args }) => args.slice(0, 2)), [
		["pane", "split"], ["agent", "start"], ["pane", "send-text"], ["agent", "focus"],
	]);
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.notifications.at(-1).level, "warning");
	assert.match(h.notifications.at(-1).text, /transferred to pane w1:p2.*app\.editor\.external has no binding/);
});

test("model selected when the source settles affects only successor startup", async () => {
	const h = harness({ onIdle: () => (h.ctx.model = OTHER_MODEL) });
	await h.run();
	assert.equal(h.calls.complete[0].model.provider, "openrouter");
	assert.equal(h.calls.complete[0].model.id, "deepseek/deepseek-v4.1-flash:nitro");
	assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "other-provider/org/other-model:free"]);
});

test("model switches after invocation do not affect generation or successor startup", async () => {
	const h = harness({
		onComplete: () => {
			h.ctx.model = OTHER_MODEL;
			return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Generated prompt" }] });
		},
	});
	await h.run();
	assert.equal(h.calls.complete[0].model.provider, "openrouter");
	assert.equal(h.calls.complete[0].model.id, "deepseek/deepseek-v4.1-flash:nitro");
	assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "test-provider/test-model"]);
	assert.equal(h.notifications.at(-1).level, "info");
});

test("request payload disables reasoning and replaces all nested reasoning settings", async () => {
	const h = harness();
	await h.run();
	const { model, requestOptions } = h.calls.complete[0];
	for (const reasoning of [undefined, { effort: "high", exclude: true, max_tokens: 8192 }]) {
		const payload = { model: model.id, messages: [], reasoning };
		const result = await requestOptions.onPayload(payload, model);
		assert.deepEqual({ ...result.reasoning }, { enabled: false });
		assert.equal(result.model, model.id);
		assert.equal(result.messages, payload.messages);
	}
	assert.equal(requestOptions.reasoning, undefined);
	assert.equal(requestOptions.reasoningEffort, undefined);
	assert.equal(requestOptions.maxTokens, undefined);
});

test("long multiline Unicode and code blocks reach send-text unchanged", async () => {
	const prompt = `## Context\n${"Keep café, 日本語, and λ intact.\n".repeat(1000)}\n\`\`\`ts\nconst goal = "next task";\n\`\`\`\nFinal line`;
	const h = harness({ response: { stopReason: "stop", content: [{ type: "text", text: prompt }] } });
	await h.run();
	assert.deepEqual(h.calls.exec[2].args, ["pane", "send-text", "w1:p2", prompt]);
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
	["missing generator", { generator: undefined }, undefined, /requires openrouter\/deepseek\/deepseek-v4\.1-flash.*pi update --models.*reload Pi/],
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
	[
		"loader cancellation followed by a late successful response",
		{ onComplete: (getLoader) => new Promise((resolve) => setImmediate(() => { getLoader().abort(); resolve({ stopReason: "stop", content: [{ type: "text", text: "Too late" }] }); })) },
		"info",
		/cancelled/,
	],
]) {
	test(`${label} makes no Herdr calls`, async () => {
		const h = harness(options);
		await h.run();
		assertNoSideEffects(h);
		assert.equal(h.calls.complete.length, 1);
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
	test(`${label} restores the generated prompt and reports the error`, async () => {
		const h = harness({ exec });
		await h.run();
		assert.equal(h.calls.exec.length, execCount);
		assert.deepEqual(h.calls.setEditorText, ["Generated prompt"]);
		assert.equal(h.notifications.at(-1).level, "error");
		assert.match(h.notifications.at(-1).text, pattern);
		assert.match(h.notifications.at(-1).text, /restored to the editor/);
		assert.equal(h.calls.newSession, 0);
	});
}

for (const [stage, key, execCount, pattern] of [
	["focus", "focus", 4, /focus failed: .*herdr agent focus failed.*Select that pane and open Pi's external editor manually/],
	["shortcut", "keys", 5, /shortcut delivery failed: .*herdr agent send-keys failed.*Review the draft in that pane manually/],
]) {
	for (const rejects of [false, true]) {
		test(`${stage} ${rejects ? "rejection" : "failure"} preserves the destination draft without source recovery`, async () => {
			const h = harness({
				externalKeys: ["ctrl+shift+e", "ctrl+g"],
				exec: { [key]: failure },
				onExec: rejects ? async (current) => {
					if (current === key) throw new Error("CLI unavailable");
				} : undefined,
			});
			await h.run();
			assert.equal(h.calls.exec.length, execCount);
			assert.deepEqual(h.calls.exec[2].args, ["pane", "send-text", "w1:p2", "Generated prompt"]);
			assert.deepEqual(h.calls.setEditorText, []);
			assert.equal(h.notifications.length, 1);
			assert.equal(h.notifications[0].level, "warning");
			assert.match(h.notifications[0].text, /Handoff draft transferred to pane w1:p2/);
			assert.match(h.notifications[0].text, rejects ? /CLI unavailable/ : pattern);
			assert.doesNotMatch(h.notifications[0].text, /restored|shortcut sent|editor opened/i);
		});
	}
}
