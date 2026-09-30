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
const JEV = Object.freeze({ type: "classifier", provider: "typesafe", id: "jev-latest" });
const classification = (score = 2.25, confidence = 0.9) => ({
	stopReason: "stop", answers: { difficulty: { type: "score", score, confidence } },
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
	const calls = { find: [], complete: [], getModelOfType: [], classify: [], getKeys: [], loaderLabels: [], exec: [], editor: [], setEditorText: [], newSession: 0, sendUserMessage: 0, setModel: 0 };
	const notifications = [];
	const events = [];
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
		setModel: () => calls.setModel++,
		async exec(command, args) {
			events.push(`exec:${args[1]}`);
			calls.exec.push({ command, args: Array.from(args) });
			const key = { split: "split", start: "start", "send-text": "send", focus: "focus", "send-keys": "keys" }[args[1]];
			await options.onExec?.(key);
			return exec[key];
		},
	};
	const ctx = {
		mode: options.mode ?? "tui",
		model: "model" in options ? options.model : MODEL,
		scopedModels: options.scopedModels ?? ELEVEN_MODELS,
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
				events.push("generate");
				const response = options.onComplete ? options.onComplete(() => loader)
					: Promise.resolve(options.response ?? { stopReason: "stop", content: [{ type: "text", text: "  Generated prompt  " }] });
				return response.then((result) => { events.push("generated"); return result; });
			},
			getModelOfType(type, provider, id) {
				calls.getModelOfType.push({ type, provider, id });
				events.push("lookup");
				if (options.onLookup) return options.onLookup(() => loader);
				return "jev" in options ? options.jev : JEV;
			},
			classify(model, context, requestOptions) {
				calls.classify.push({ model, context, requestOptions });
				events.push("classify");
				const response = options.onClassify ? options.onClassify(() => loader)
					: Promise.resolve("classification" in options ? options.classification : classification());
				return response.then((result) => { events.push("classified"); return result; });
			},
		},
		ui: {
			notify: (text, level) => { events.push(`notify:${level}`); notifications.push({ text, level }); },
			custom: (factory) => new Promise((resolve) => factory({}, {}, {
				getKeys: (action) => {
					calls.getKeys.push(action);
					return externalKeys;
				},
			}, (result) => { events.push("loader-done"); resolve(result); })),
			editor: async (title, prefill) => {
				calls.editor.push({ title, prefill });
				throw new Error("Source review must not open");
			},
			setEditorText: (text) => calls.setEditorText.push(text),
		},
	};

	const exports = {};
	runInNewContext(`${compiled}\nexports.selectModelByPriceRank = selectModelByPriceRank;`, {
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
		assert.equal(calls.setModel, 0);
		for (const { args } of calls.exec) {
			assert.ok(!args.includes("--thinking"), "must not select a thinking level");
			assert.ok(!["prompt", "run"].includes(args[1]), "must not submit a prompt");
			if (args[1] === "send-keys") {
				assert.deepEqual(args, ["agent", "send-keys", "w1:p2", externalKeys[0]]);
				assert.ok(!args.slice(3).some((key) => /^(enter|return)$/i.test(key)));
			}
		}
	};
	return { calls, ctx, notifications, events, run, getLoader: () => loader, selectModelByPriceRank: exports.selectModelByPriceRank };
}

function scopedModel(provider, id, output, thinkingLevel) {
	return Object.freeze({
		model: Object.freeze({ provider, id, cost: Object.freeze({ input: 1, output, cacheRead: 1, cacheWrite: 1 }) }),
		thinkingLevel,
	});
}

for (const [label, prices, score, expectedIndex] of [
	["empty scope", [], 1.5, undefined],
	["single model at minimum", [7], 0, 0],
	["single model at midpoint", [7], 1.5, 0],
	["single model at maximum", [7], 3, 0],
	["unsorted minimum", [20, 1, 5], 0, 1],
	["unsorted midpoint", [20, 1, 5], 1.5, 2],
	["unsorted maximum", [20, 1, 5], 3, 0],
	["rank rather than dollar interpolation", [1, 2, 1000], 1.5, 1],
	["equal prices first", [7, 7, 7], 0, 0],
	["equal prices middle", [7, 7, 7], 1.5, 1],
	["equal prices last", [7, 7, 7], 3, 2],
	["zero price", [5, 0, 2], 0, 1],
	["all zero prices", [0, 0, 0], 1.5, 1],
	["clamp below zero", [20, 1, 5], -100, 1],
	["clamp above three", [20, 1, 5], 100, 0],
	["two-model midpoint rounds up", [1, 5], 1.5, 1],
	["NaN score", [1, 5], NaN, undefined],
	["positive infinite score", [1, 5], Infinity, undefined],
	["negative infinite score", [1, 5], -Infinity, undefined],
	["single model still rejects nonfinite score", [1], NaN, undefined],
	["numeric string score", [1, 5], "1.5", undefined],
	["missing score", [1, 5], undefined, undefined],
]) {
	test(`price rank: ${label}`, () => {
		const scope = Object.freeze(prices.map((price, i) => scopedModel("test", `model-${i}`, price)));
		const before = structuredClone(scope);
		assert.equal(harness().selectModelByPriceRank(scope, score), scope[expectedIndex]?.model);
		assert.deepEqual(scope, before);
	});
}

for (const [label, cost] of [
	["missing cost", undefined],
	["null cost", null],
	["missing output", {}],
	["undefined output", { output: undefined }],
	["null output", { output: null }],
	["string output", { output: "5" }],
	["boolean output", { output: false }],
	["negative output", { output: -1 }],
	["NaN output", { output: NaN }],
	["positive infinite output", { output: Infinity }],
	["negative infinite output", { output: -Infinity }],
]) {
	test(`price rank rejects the entire scope: ${label}`, () => {
		const invalid = Object.freeze({ model: Object.freeze({ provider: "test", id: "invalid", cost: Object.freeze(cost) }) });
		const valid = scopedModel("test", "valid", 0);
		const select = harness().selectModelByPriceRank;
		for (const entries of [[invalid], [valid, invalid], [invalid, valid]]) {
			const scope = Object.freeze(entries);
			for (const score of [0, 1.5, 3]) assert.equal(select(scope, score), undefined);
		}
	});
}

// Fixed snapshot in configured scope order, not a lookup of live settings or catalog prices.
const ELEVEN_MODELS = Object.freeze([
	["openai-codex", "gpt-5.6-terra", 12],
	["openrouter", "deepseek/deepseek-v4.1-flash", 0.396],
	["openai-codex", "gpt-6-astra", 50],
	["anthropic", "claude-fable-5-1", 50],
	["github-copilot", "gpt-5.6-terra", 12],
	["github-copilot", "claude-sonnet-5", 10],
	["github-copilot", "gemini-3.5-flash", 9],
	["github-copilot", "claude-haiku-4.5", 5],
	["openrouter", "deepseek/deepseek-v4-pro-0813", 1.98],
	["openai-codex", "gpt-5.6-sol", 20],
	["anthropic", "claude-opus-5-5", 20],
].map(([provider, id, price]) => scopedModel(provider, id, price)));
const PRICE_RANKS = [1, 8, 7, 6, 5, 0, 4, 9, 10, 2, 3];

for (const [rank, scopeIndex] of PRICE_RANKS.entries()) {
	test(`price rank: 11-model fixture rank ${rank}`, () => {
		const before = structuredClone(ELEVEN_MODELS);
		assert.equal(harness().selectModelByPriceRank(ELEVEN_MODELS, rank * 0.3), ELEVEN_MODELS[scopeIndex].model);
		assert.deepEqual(ELEVEN_MODELS, before);
	});
}

for (const [score, rank] of [[0, 0], [0.46, 2], [1, 3], [1.02, 3], [1.64, 5], [1.79, 6], [2, 7], [2.25, 8], [3, 10]]) {
	test(`price rank: spec example ${score}`, () => {
		assert.equal(harness().selectModelByPriceRank(ELEVEN_MODELS, score), ELEVEN_MODELS[PRICE_RANKS[rank]].model);
	});
}

// The specified JS formula falls just below the mathematical midpoint at 0.15 and 1.65.
// Preserve its exact arithmetic, without adding an epsilon or rounding the score first.
for (const [boundary, lowerRank, atRank] of [
	[0.15, 0, 0], [0.45, 1, 2], [0.75, 2, 3], [1.05, 3, 4], [1.35, 4, 5],
	[1.65, 5, 5], [1.95, 6, 7], [2.25, 7, 8], [2.55, 8, 9], [2.85, 9, 10],
]) {
	test(`price rank: before, at, and after boundary ${boundary}`, () => {
		const select = harness().selectModelByPriceRank;
		for (const [score, rank] of [[boundary - 1e-12, lowerRank], [boundary, atRank], [boundary + 1e-12, lowerRank + 1]]) {
			assert.equal(select(ELEVEN_MODELS, score), ELEVEN_MODELS[PRICE_RANKS[rank]].model, `score ${score}`);
		}
	});
}

test("price rank ignores thinkingLevel", () => {
	const select = harness().selectModelByPriceRank;
	for (const level of [undefined, "off", "low", "medium", "high", "xhigh"]) {
		const scope = Object.freeze(ELEVEN_MODELS.map((entry, i) => Object.freeze({
			model: entry.model,
			thinkingLevel: i % 2 ? level : "high",
		})));
		for (const [rank, scopeIndex] of PRICE_RANKS.entries()) {
			assert.equal(select(scope, rank * 0.3), ELEVEN_MODELS[scopeIndex].model);
		}
	}
});

test("price rank uses only base output price", () => {
	const scope = Object.freeze(ELEVEN_MODELS.map(({ model }, i) => Object.freeze({
		model: Object.freeze({
			...model,
			cost: Object.freeze({
				output: model.cost.output, input: NaN, cacheRead: -1, cacheWrite: Infinity,
				tiers: Object.freeze([Object.freeze({ inputTokensAbove: 1000, output: 100 - i, input: 1, cacheRead: 1, cacheWrite: 1 })]),
			}),
		}),
	})));
	const select = harness().selectModelByPriceRank;
	for (const [rank, scopeIndex] of PRICE_RANKS.entries()) {
		assert.equal(select(scope, rank * 0.3), scope[scopeIndex].model);
	}
});

function assertNoSideEffects(h) {
	assert.equal(h.calls.exec.length, 0);
	assert.equal(h.calls.setEditorText.length, 0);
	assert.equal(h.calls.newSession, 0);
	assert.equal(h.calls.sendUserMessage, 0);
	assert.equal(h.calls.setModel, 0);
}

test("successful handoff generates, classifies, pastes, focuses, and sends only the external-editor shortcut", async () => {
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
	assert.equal(h.ctx.scopedModels, ELEVEN_MODELS);
	assert.deepEqual(h.calls.loaderLabels, ["Generating handoff and selecting successor model..."]);
	assert.match(context.systemPrompt, /Output only the prompt itself/);
	const input = context.messages[0].content[0].text;
	assert.ok(input.includes(JSON.stringify(BRANCH.map((entry) => entry.message))));
	assert.ok(input.endsWith("## User's Goal for New Thread\n\nimplement phase one"));
	assert.equal(requestOptions.cacheRetention, "none");
	assert.equal(requestOptions.sessionId, "session-id");
	assert.ok(requestOptions.signal);

	assert.deepEqual(h.calls.getModelOfType, [{ type: "classifier", provider: "typesafe", id: "jev-latest" }]);
	assert.equal(h.calls.classify.length, 1);
	const [rating] = h.calls.classify;
	assert.equal(rating.model, JEV);
	assert.deepEqual(Object.keys(rating.requestOptions), ["signal"]);
	assert.equal(rating.requestOptions.signal, requestOptions.signal);
	assert.deepEqual(structuredClone(rating.context), {
		state: { prompt: "Generated prompt" },
		questions: {
			difficulty: {
				type: "score",
				instructions: "Rate the difficulty of the next task requested in this handoff prompt. Use the context to understand the task. Rate the work that remains, not completed work or prompt length. Do not choose a model.",
				criteria: [
					"Trivial: A mechanical, localized change or simple factual response. The required action is explicit and needs almost no investigation or judgment.",
					"Routine: A familiar, bounded task with clear requirements. It needs ordinary implementation, documentation, or configuration work and straightforward verification.",
					"Hard: Substantial reasoning, investigation, or review. It involves several interacting parts, ambiguous requirements, non-obvious bugs, or meaningful design trade-offs.",
					"Very hard: Deep reasoning about subtle failures or architecture. It involves difficult concurrency, cross-cutting constraints, or substantial uncertainty with no straightforward solution.",
				],
			},
		},
	});
	assert.equal(h.notifications.length, 2);
	assert.deepEqual(h.notifications[0], {
		text: "Handoff: Jev difficulty 2.25/3 -> anthropic/claude-opus-5-5. Override with /model in the new session before submitting.",
		level: "info",
	});
	assert.deepEqual(h.events, [
		"generate", "generated", "lookup", "classify", "classified", "loader-done", "notify:info",
		"exec:split", "exec:start", "exec:send-text", "exec:focus", "exec:send-keys", "notify:info",
	]);

	assert.deepEqual(h.calls.editor, []);
	assert.deepEqual(h.calls.getKeys, ["app.editor.external"]);
	const name = `handoff-${NOW.toString(36)}`;
	assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
	assert.deepEqual(h.calls.exec, [
		{ command: "/bin/herdr", args: ["pane", "split", "--current", "--direction", "right", "--cwd", "/work/project", "--no-focus"] },
		{
			command: "/bin/herdr",
			args: ["agent", "start", name, "--kind", "pi", "--pane", "w1:p2", "--", "--model", "anthropic/claude-opus-5-5"],
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

for (const [label, options, reason, lookups, classifications] of [
	["empty scope", { scopedModels: [] }, "no scoped models", 0, 0],
	["missing Jev", { jev: undefined }, "Jev not in catalog", 1, 0],
	["lookup throws", { onLookup: () => { throw new Error("lookup failed"); } }, "classification failed", 1, 0],
	["call throws", { onClassify: () => { throw new Error("provider failed"); } }, "classification failed", 1, 1],
	["call rejects", { onClassify: () => Promise.reject(new Error("network down")) }, "classification failed", 1, 1],
	...["missing credentials", "network error", "provider error", "context limit"].map((errorMessage) => [
		errorMessage, { classification: { stopReason: "error", errorMessage, answers: classification().answers } }, "classification failed", 1, 1,
	]),
	...[undefined, null, {}, { stopReason: "unknown", answers: classification().answers }].map((result, i) => [
		`malformed result ${i}`, { classification: result }, "classification failed", 1, 1,
	]),
	...[undefined, null, {}, { difficulty: null }, { difficulty: { type: "choice", score: 2.25 } },
		{ difficulty: { type: "bool", score: 2.25 } }, { difficulty: { score: 2.25 } },
		...[undefined, null, "2.25", NaN, Infinity, -Infinity].map((score) => ({ difficulty: { type: "score", score } })),
	].map((answers, i) => [
		`invalid answer ${i}`, { classification: { stopReason: "stop", answers } }, "invalid difficulty score", 1, 1,
	]),
	...[undefined, null, {}, { output: "5" }, { output: -1 }, { output: NaN }, { output: Infinity }, { output: -Infinity }].map((cost, i) => [
		`invalid scoped price ${i}`,
		{ scopedModels: [...ELEVEN_MODELS, { model: { provider: "bad", id: "bad", cost } }] },
		"invalid output prices", 0, 0,
	]),
]) {
	test(`selection fallback: ${label}`, async () => {
		const h = harness(options);
		await h.run();
		assert.equal(h.calls.complete.length, 1);
		assert.equal(h.calls.getModelOfType.length, lookups);
		assert.equal(h.calls.classify.length, classifications);
		assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "test-provider/test-model"]);
		assert.deepEqual(h.calls.exec[2].args, ["pane", "send-text", "w1:p2", "Generated prompt"]);
		assert.deepEqual(h.notifications[0], {
			text: `Handoff: Jev selection unavailable (${reason}). Using source model test-provider/test-model.`,
			level: "warning",
		});
		assert.equal(h.notifications.length, 2);
		assert.equal(h.notifications[1].level, "info");
		assert.equal(h.ctx.model, MODEL);
		assert.ok(!h.ctx.scopedModels.some(({ model }) => model === MODEL), "fallback source is outside scope");
		assert.deepEqual(h.calls.setEditorText, []);
		assert.ok(h.events.indexOf("loader-done") < h.events.indexOf("notify:warning"));
		assert.ok(h.events.indexOf("notify:warning") < h.events.indexOf("exec:split"));
	});
}

for (const [score, expectedIndex, display] of [[-2, 1, "0.00"], [0, 1, "0.00"], [2.249, 9, "2.25"], [3, 3, "3.00"], [7, 3, "3.00"]]) {
	test(`classification score ${score} clamps and maps before display rounding`, async () => {
		const h = harness({ classification: classification(score) });
		await h.run();
		const model = ELEVEN_MODELS[expectedIndex].model;
		assert.equal(h.calls.exec[1].args.at(-1), `${model.provider}/${model.id}`);
		assert.ok(h.notifications[0].text.includes(`difficulty ${display}/3`));
		assert.equal(h.notifications[0].level, "info");
	});
}

for (const confidence of [0, 0.01, undefined, NaN]) {
	test(`confidence ${confidence} does not gate a valid score`, async () => {
		const result = classification();
		result.answers.difficulty.confidence = confidence;
		const h = harness({ classification: result });
		await h.run();
		assert.equal(h.calls.exec[1].args.at(-1), "anthropic/claude-opus-5-5");
		assert.equal(h.notifications[0].level, "info");
	});
}

test("single scoped model still receives classification and a rating", async () => {
	const h = harness({ scopedModels: [scopedModel("single", "free", 0, "xhigh")] });
	await h.run();
	assert.equal(h.calls.classify.length, 1);
	assert.equal(h.calls.exec[1].args.at(-1), "single/free");
	assert.match(h.notifications[0].text, /Jev difficulty 2\.25\/3 -> single\/free/);
});

test("captures scoped models after waiting for idle", async () => {
	const h = harness({ scopedModels: [], onIdle: () => { h.ctx.scopedModels = ELEVEN_MODELS; } });
	await h.run();
	assert.equal(h.calls.classify.length, 1);
	assert.equal(h.calls.exec[1].args.at(-1), "anthropic/claude-opus-5-5");
});

for (const stage of ["generation", "classification"]) {
	test(`source and scope switches during ${stage} do not change the captured candidates`, async () => {
		const scope = [...ELEVEN_MODELS];
		const change = () => {
			h.ctx.model = OTHER_MODEL;
			scope.reverse();
			scope.splice(0, scope.length, scopedModel("replacement", "model", 0));
			h.ctx.scopedModels = [];
		};
		const h = harness({
			scopedModels: scope,
			onComplete: () => {
				if (stage === "generation") change();
				return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Generated prompt" }] });
			},
			onClassify: () => {
				if (stage === "classification") change();
				return Promise.resolve(classification());
			},
		});
		await h.run();
		assert.equal(h.calls.exec[1].args.at(-1), "anthropic/claude-opus-5-5");
		assert.equal(h.calls.complete[0].model.id, "deepseek/deepseek-v4.1-flash:nitro");
		assert.equal(h.ctx.model, OTHER_MODEL);
	});
}

test("classification failure uses the source captured before model and scope switches", async () => {
	const h = harness({ onClassify: () => {
		h.ctx.model = OTHER_MODEL;
		h.ctx.scopedModels = [];
		return Promise.reject(new Error("network down"));
	} });
	await h.run();
	assert.equal(h.calls.exec[1].args.at(-1), "test-provider/test-model");
	assert.match(h.notifications[0].text, /Using source model test-provider\/test-model/);
});

test("pending classification keeps the loader open and prevents notifications and pane creation", async () => {
	const pending = Promise.withResolvers();
	const started = Promise.withResolvers();
	const h = harness({ onClassify: () => { started.resolve(); return pending.promise; } });
	const run = h.run();
	await started.promise;
	assertNoSideEffects(h);
	assert.deepEqual(h.notifications, []);
	assert.ok(!h.events.includes("loader-done"));
	pending.resolve(classification());
	await run;
	assert.ok(h.events.indexOf("classified") < h.events.indexOf("loader-done"));
	assert.ok(h.events.indexOf("loader-done") < h.events.indexOf("notify:info"));
	assert.ok(h.events.indexOf("notify:info") < h.events.indexOf("exec:split"));
});

for (const late of ["success", "error", "rejection"]) {
	for (const stage of ["generation", "classification"]) {
		test(`Escape during ${stage} ignores late ${late}`, async () => {
			const pending = Promise.withResolvers();
			const started = Promise.withResolvers();
			const h = harness({
				[stage === "generation" ? "onComplete" : "onClassify"]: () => { started.resolve(); return pending.promise; },
			});
			const run = h.run();
			await started.promise;
			h.getLoader().abort();
			await run;
			assertNoSideEffects(h);
			assert.deepEqual(h.notifications, [{ text: "Handoff cancelled", level: "info" }]);
			assert.equal(h.calls.complete[0].requestOptions.signal.aborted, true);
			if (late === "rejection") pending.reject(new Error("too late"));
			else if (late === "error") pending.resolve({ stopReason: "error", errorMessage: "too late", content: [] });
			else pending.resolve(stage === "generation"
				? { stopReason: "stop", content: [{ type: "text", text: "Too late" }] } : classification());
			await new Promise(setImmediate);
			assertNoSideEffects(h);
			assert.deepEqual(h.notifications, [{ text: "Handoff cancelled", level: "info" }]);
			assert.equal(h.calls.getModelOfType.length, stage === "generation" ? 0 : 1);
			assert.equal(h.calls.classify.length, stage === "generation" ? 0 : 1);
			assert.equal(h.events.filter((event) => event === "loader-done").length, 1);
		});
	}
}

for (const [label, options, classifyCount] of [
	["classifier reports aborted", { classification: { stopReason: "aborted", answers: classification().answers } }, 1],
	["signal abort before lookup", { onComplete: (getLoader) => {
		getLoader().controller.abort();
		return Promise.resolve({ stopReason: "stop", content: [{ type: "text", text: "Generated prompt" }] });
	} }, 0],
	["lookup aborts then returns Jev", { onLookup: (getLoader) => { getLoader().controller.abort(); return JEV; } }, 0],
	["lookup aborts then throws", { onLookup: (getLoader) => { getLoader().controller.abort(); throw new Error("aborted"); } }, 0],
	["signal abort followed by generation rejection", { onComplete: (getLoader) => {
		getLoader().controller.abort(); return Promise.reject(new Error("aborted"));
	} }, 0],
	["signal abort followed by classifier rejection", { onClassify: (getLoader) => {
		getLoader().controller.abort(); return Promise.reject(new Error("aborted"));
	} }, 1],
	["signal abort followed by classifier success", { onClassify: (getLoader) => {
		getLoader().controller.abort(); return Promise.resolve(classification());
	} }, 1],
]) {
	test(`${label} cancels without fallback`, async () => {
		const h = harness(options);
		await h.run();
		assertNoSideEffects(h);
		assert.equal(h.calls.classify.length, classifyCount);
		assert.deepEqual(h.notifications, [{ text: "Handoff cancelled", level: "info" }]);
	});
}

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

test("fallback uses the source model selected after waiting for idle", async () => {
	const h = harness({ scopedModels: [], onIdle: () => (h.ctx.model = OTHER_MODEL) });
	await h.run();
	assert.equal(h.calls.complete[0].model.provider, "openrouter");
	assert.equal(h.calls.complete[0].model.id, "deepseek/deepseek-v4.1-flash:nitro");
	assert.deepEqual(h.calls.exec[1].args.slice(-3), ["--", "--model", "other-provider/org/other-model:free"]);
});

test("model switches after capture do not affect generation or the source fallback", async () => {
	const h = harness({
		jev: undefined,
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
	assert.deepEqual(structuredClone(h.calls.classify[0].context.state), { prompt });
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
		assert.equal(h.calls.getModelOfType.length, 0);
		assert.equal(h.calls.classify.length, 0);
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
		await new Promise(setImmediate);
		assertNoSideEffects(h);
		assert.equal(h.calls.complete.length, 1);
		assert.equal(h.calls.getModelOfType.length, 0);
		assert.equal(h.calls.classify.length, 0);
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
		assert.equal(h.calls.classify.length, 1);
		assert.equal(h.notifications.length, 2);
		assert.equal(h.notifications[0].level, "info");
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
			assert.equal(h.notifications.length, 2);
			assert.equal(h.notifications[0].level, "info");
			assert.equal(h.notifications[1].level, "warning");
			assert.match(h.notifications[1].text, /Handoff draft transferred to pane w1:p2/);
			assert.match(h.notifications[1].text, rejects ? /CLI unavailable/ : pattern);
			assert.doesNotMatch(h.notifications[1].text, /restored|shortcut sent|editor opened/i);
		});
	}
}
