// Run from the repository root: node --test agent/extensions/handoff/handoff.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { before, describe, it, mock } = require("node:test");
const ts = require("typescript");

// Exercise both production modules. Only Pi's UI, model requests, and process
// execution are replaced. Unlisted imports fail rather than reaching the host.
const modules = new Map(["index", "herdr"].map((name) => [name, ts.transpileModule(
	fs.readFileSync(path.join(__dirname, `${name}.ts`), "utf8"),
	{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText]));
let piRuntime;
before(async () => { piRuntime = await import("@earendil-works/pi-coding-agent"); });

const cwd = "/projects/a directory; $(not-a-command)";
const destination = "workspace:successor";
const generator = Object.freeze({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash" });
const sourceModel = Object.freeze({ provider: "source", id: "org/model:variant" });
const environment = { HERDR_ENV: "1", HERDR_PANE_ID: "workspace:source", HERDR_BIN_PATH: "/custom bin/herdr" };
const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const splitResult = () => success(JSON.stringify({ result: { pane: { pane_id: destination } } }));
const answer = (text = "Continue the implementation.") => ({ stopReason: "stop", content: [{ type: "text", text }] });
const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const settle = () => new Promise(setImmediate);

function loadModules(env, dependencies = {}) {
	const cache = new Map();
	function load(name) {
		if (cache.has(name)) return cache.get(name);
		const exports = {};
		cache.set(name, exports);
		vm.runInNewContext(modules.get(name), {
			exports,
			process: { env },
			Error,
			require(specifier) {
				if (specifier === "./herdr") return load("herdr");
				assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected import: ${specifier}`);
				return dependencies[specifier];
			},
		}, { filename: path.join(__dirname, `${name}.ts`) });
		return exports;
	}
	return load;
}

function setup(options = {}) {
	const events = [];
	const notifications = [];
	const drafts = [];
	const loaders = [];
	const commands = new Map();
	const session = options.session ?? piRuntime.SessionManager.inMemory(cwd);
	if (!options.session) session.appendMessage(userMessage("The parser needs validation."));
	let editorText = "Existing source draft";

	class TestLoader {
		constructor(_tui, _theme, label) {
			this.label = label;
			this.controller = new AbortController();
			this.dispose = mock.fn();
			loaders.push(this);
		}
		get signal() { return this.controller.signal; }
		cancel() {
			this.controller.abort();
			this.onAbort();
		}
	}

	const api = {
		registerCommand: (name, definition) => commands.set(name, definition),
		exec: mock.fn(async (binary, args) => {
			events.push(args[1]);
			if (options.exec) return options.exec(binary, args);
			return args[1] === "split" ? splitResult() : success();
		}),
	};
	const ctx = {
		mode: "tui",
		cwd,
		model: sourceModel,
		waitForIdle: mock.fn(async () => { events.push("idle"); await options.idle?.(); }),
		sessionManager: {
			buildSessionProjection: mock.fn(() => {
				events.push("projection");
				return session.buildSessionProjection();
			}),
		},
		modelRegistry: {
			find: mock.fn(() => generator),
			complete: mock.fn(async (...args) => {
				events.push("generate");
				return options.complete ? options.complete(...args) : answer();
			}),
		},
		ui: {
			notify: (text, level) => notifications.push({ text, level }),
			setEditorText: (text) => { drafts.push(text); editorText = text; },
			// Match Pi's asynchronous mount: done can only dispose a captured
			// component. Completion before mounting otherwise leaks the loader.
			custom: mock.fn((factory) => new Promise((resolve, reject) => {
				let component;
				let closed = false;
				Promise.resolve(factory({}, {}, {
					getKeys: () => assert.fail("Handoff must not inspect editor keybindings"),
				}, (value) => {
					if (closed) return;
					closed = true;
					events.push("loader closed");
					resolve(value);
					component?.dispose();
				})).then((mounted) => {
					if (!closed) component = mounted;
				}).catch(reject);
			})),
		},
	};
	const load = loadModules(options.env ?? { ...environment }, {
		"@earendil-works/pi-ai": { uuidv7: () => "isolated-generation-session" },
		"@earendil-works/pi-coding-agent": {
			BorderedLoader: TestLoader,
			convertToLlm: piRuntime.convertToLlm,
			serializeConversation: piRuntime.serializeConversation,
		},
	});
	load("index").default(api);
	return {
		api, ctx, session, events, notifications, drafts, loaders, commands,
		run: (goal = "Finish validation") => commands.get("handoff").handler(goal, ctx),
		executions: () => api.exec.mock.calls.map(({ arguments: [binary, args] }) => ({ binary, args: Array.from(args) })),
		editorText: () => editorText,
	};
}

function assertSourceUntouched(h) {
	assert.deepEqual(h.drafts, []);
	assert.equal(h.editorText(), "Existing source draft");
}

function assertLoaderDisposed(h) {
	assert.equal(h.loaders.length, 1);
	assert.equal(h.loaders[0].dispose.mock.callCount(), 1);
}

function assertError(h, pattern) {
	assert.equal(h.notifications.length, 1);
	assert.equal(h.notifications[0].level, "error");
	assert.match(h.notifications[0].text, pattern);
}

describe("handoff command", { timeout: 5000 }, () => {
	it("registers only /handoff", () => {
		const h = setup();
		assert.deepEqual([...h.commands.keys()], ["handoff"]);
		assert.match(h.commands.get("handoff").description, /fresh Pi session/);
	});

	it("generates from the projected session and transfers an unsubmitted draft in order", async () => {
		const h = setup();
		const originalEntries = structuredClone(h.session.getEntries());
		await h.run("  Finish validation  \n");

		assert.deepEqual(h.events, ["idle", "projection", "generate", "loader closed", "split", "start", "send-text", "focus", "send-keys"]);
		assert.equal(h.ctx.waitForIdle.mock.callCount(), 1);
		assert.equal(h.ctx.sessionManager.buildSessionProjection.mock.callCount(), 1);
		assert.equal(h.ctx.modelRegistry.find.mock.callCount(), 1);
		assert.deepEqual(Array.from(h.ctx.modelRegistry.find.mock.calls[0].arguments), ["openrouter", "deepseek/deepseek-v4.1-flash"]);
		assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 1);
		const [model, request, settings] = h.ctx.modelRegistry.complete.mock.calls[0].arguments;
		assert.equal(model, generator);
		assert.match(request.systemPrompt, /Output only the prompt itself/);
		assert.equal(request.messages.length, 1);
		assert.equal(request.messages[0].role, "user");
		assert.equal(request.messages[0].content[0].text,
			"## Conversation History\n\n[User]: The parser needs validation.\n\n## User's Goal for New Thread\n\nFinish validation");
		assert.equal(typeof request.messages[0].timestamp, "number");
		assert.equal(settings.cacheRetention, "none");
		assert.equal(settings.sessionId, "isolated-generation-session");
		assert.equal(settings.signal, h.loaders[0].signal);
		assert.equal(settings.signal.aborted, false);
		assert.deepEqual(h.loaders.map(({ label }) => label), ["Generating handoff prompt..."]);

		const calls = h.executions();
		const agentName = calls[1].args[2];
		assert.match(agentName, /^handoff-[a-z0-9]+$/);
		assert.ok(agentName.length <= 32);
		assert.deepEqual(calls, [
			{ binary: environment.HERDR_BIN_PATH, args: ["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"] },
			{ binary: environment.HERDR_BIN_PATH, args: ["agent", "start", agentName, "--kind", "pi", "--pane", destination, "--", "--model", "source/org/model:variant"] },
			{ binary: environment.HERDR_BIN_PATH, args: ["pane", "send-text", destination, "Continue the implementation."] },
			{ binary: environment.HERDR_BIN_PATH, args: ["agent", "focus", destination] },
			{ binary: environment.HERDR_BIN_PATH, args: ["agent", "send-keys", destination, "ctrl+g"] },
		]);
		assert.deepEqual(h.notifications, [{
			text: `Handoff draft sent to pane ${destination}. Save and close the editor, then press Enter in Pi.`,
			level: "info",
		}]);
		assertLoaderDisposed(h);
		assert.equal(h.ctx.model, sourceModel);
		assert.deepEqual(h.session.getEntries(), originalEntries);
		assertSourceUntouched(h);
	});

	it("waits for idle before capturing the model and history, then keeps that model", async () => {
		const idle = Promise.withResolvers();
		const replacement = { provider: "replacement", id: "org/new:free" };
		const h = setup({ idle: () => idle.promise, complete: async () => {
			h.ctx.model = { provider: "later", id: "not-the-successor" };
			return answer();
		} });
		const running = h.run();
		assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
		assert.equal(h.ctx.sessionManager.buildSessionProjection.mock.callCount(), 0);
		assert.deepEqual(h.executions(), []);
		h.ctx.model = replacement;
		h.session.appendMessage(userMessage("Work completed while waiting."));
		idle.resolve();
		await running;
		assert.equal(h.executions()[1].args.at(-1), "replacement/org/new:free");
		assert.match(h.ctx.modelRegistry.complete.mock.calls[0].arguments[1].messages[0].content[0].text, /Work completed while waiting/);
	});

	it("uses Pi's latest compaction summary and retained messages, not dropped history", async () => {
		const session = piRuntime.SessionManager.inMemory(cwd);
		const old = session.appendMessage(userMessage("Obsolete discussion"));
		session.appendCompaction("Superseded summary", old, 100);
		session.appendMessage(userMessage("Also obsolete"));
		const kept = session.appendMessage(userMessage("Retained decision"));
		session.appendCompaction("Current summary", kept, 200);
		session.appendMessage(userMessage("Most recent task"));
		const h = setup({ session });
		await h.run();
		const text = h.ctx.modelRegistry.complete.mock.calls[0].arguments[1].messages[0].content[0].text;
		assert.match(text, /Current summary/);
		assert.match(text, /Retained decision/);
		assert.match(text, /Most recent task/);
		assert.doesNotMatch(text, /Obsolete discussion|Superseded summary|Also obsolete/);
	});

	it("replaces reasoning options without changing the rest of the payload", async () => {
		const h = setup();
		await h.run();
		const settings = h.ctx.modelRegistry.complete.mock.calls[0].arguments[2];
		for (const reasoning of [undefined, { effort: "high", exclude: true, max_tokens: 4096 }]) {
			const payload = { model: generator.id, messages: [], reasoning };
			const result = settings.onPayload(payload);
			assert.deepEqual(structuredClone(result), { ...payload, reasoning: { enabled: false } });
			assert.equal(result.messages, payload.messages);
			assert.equal(payload.reasoning, reasoning);
		}
		assert.equal(settings.reasoning, undefined);
		assert.equal(settings.reasoningEffort, undefined);
	});

	it("joins only text blocks and trims only the prompt boundaries", async () => {
		const h = setup({ complete: async () => ({ stopReason: "stop", content: [
			{ type: "thinking", thinking: "Private reasoning" },
			{ type: "text", text: "  First section\n" },
			{ type: "toolCall", id: "unused", name: "unused", arguments: {} },
			{ type: "text", text: "Last section  " },
		] }) });
		await h.run();
		assert.equal(h.executions()[2].args[3], "First section\n\nLast section");
	});

	it("preserves a long multiline Unicode prompt as one literal CLI argument", async () => {
		const prompt = `--literal $(touch nothing) 'quoted'\n${"café 日本語 λ\n".repeat(1500)}\n\`\`\`ts\nconst text = "next";\n\`\`\`\nFinal line`;
		const h = setup({ complete: async () => answer(prompt) });
		await h.run();
		assert.deepEqual(h.executions()[2].args, ["pane", "send-text", destination, prompt]);
	});

	it("awaits each Herdr command before starting the next", async () => {
		const stages = ["split", "start", "send-text", "focus", "send-keys"];
		const gates = stages.map(() => ({ started: Promise.withResolvers(), finish: Promise.withResolvers() }));
		const h = setup({ exec: async (_binary, args) => {
			const gate = gates[stages.indexOf(args[1])];
			gate.started.resolve();
			await gate.finish.promise;
			return args[1] === "split" ? splitResult() : success();
		} });
		const running = h.run();
		for (const [index, gate] of gates.entries()) {
			await gate.started.promise;
			assert.deepEqual(h.executions().map(({ args }) => args[1]), stages.slice(0, index + 1));
			assert.deepEqual(h.notifications, []);
			gate.finish.resolve();
		}
		await running;
		assert.equal(h.notifications[0].level, "info");
	});

	for (const [label, configure, pattern] of [
		["RPC mode", (h) => { h.ctx.mode = "rpc"; }, /requires interactive mode/],
		["print mode", (h) => { h.ctx.mode = "print"; }, /requires interactive mode/],
		["missing model", (h) => { h.ctx.model = undefined; }, /No model selected/],
	]) {
		it(`rejects ${label} before generation`, async () => {
			const h = setup();
			configure(h);
			await h.run();
			assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
			assert.equal(h.ctx.ui.custom.mock.callCount(), 0);
			assert.deepEqual(h.executions(), []);
			assertSourceUntouched(h);
			assertError(h, pattern);
		});
	}

	for (const goal of ["", " \n\t "]) {
		it(`rejects an empty goal ${JSON.stringify(goal)}`, async () => {
			const h = setup();
			await h.run(goal);
			assert.equal(h.ctx.waitForIdle.mock.callCount(), 0);
			assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
			assert.deepEqual(h.executions(), []);
			assertSourceUntouched(h);
			assertError(h, /Usage: \/handoff/);
		});
	}

	for (const env of [{}, { HERDR_PANE_ID: "source" }, { HERDR_ENV: "0", HERDR_PANE_ID: "source" }, { HERDR_ENV: "1" }, { HERDR_ENV: "1", HERDR_PANE_ID: "" }]) {
		it(`rejects invalid Herdr environment ${JSON.stringify(env)}`, async () => {
			const h = setup({ env });
			await h.run();
			assert.equal(h.ctx.waitForIdle.mock.callCount(), 0);
			assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
			assert.deepEqual(h.executions(), []);
			assertSourceUntouched(h);
			assertError(h, /inside a Herdr pane/);
		});
	}

	it("reports a missing generator without a fallback request", async () => {
		const h = setup();
		h.ctx.modelRegistry.find.mock.mockImplementation(() => undefined);
		await h.run();
		assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
		assert.deepEqual(h.executions(), []);
		assertSourceUntouched(h);
		assertError(h, /deepseek\/deepseek-v4\.1-flash not found.*pi update --models.*reload Pi/);
		assertLoaderDisposed(h);
	});

	it("rejects an empty projected conversation", async () => {
		const h = setup({ session: piRuntime.SessionManager.inMemory(cwd) });
		await h.run();
		assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 0);
		assert.deepEqual(h.executions(), []);
		assertSourceUntouched(h);
		assertError(h, /Conversation must not be empty/);
		assertLoaderDisposed(h);
	});

	for (const [label, complete, pattern] of [
		["empty text", async () => answer(" \n "), /empty prompt/],
		["no text blocks", async () => ({ stopReason: "stop", content: [{ type: "thinking", thinking: "Only reasoning" }] }), /empty prompt/],
		["provider error", async () => ({ ...answer("Partial text"), stopReason: "error", errorMessage: "Quota exceeded" }), /Quota exceeded/],
		["provider error without a message", async () => ({ ...answer(), stopReason: "error" }), /Model request failed/],
		["aborted response", async () => ({ ...answer("Partial text"), stopReason: "aborted" }), /Prompt generation aborted/],
		["rejected request", async () => { throw new Error("Network unavailable"); }, /Network unavailable/],
		["non-Error rejection", async () => { throw "Request refused"; }, /Request refused/],
	]) {
		it(`reports ${label} without launching or replacing the source draft`, async () => {
			const h = setup({ complete });
			await h.run();
			assert.equal(h.ctx.modelRegistry.complete.mock.callCount(), 1);
			assertLoaderDisposed(h);
			assert.deepEqual(h.executions(), []);
			assertSourceUntouched(h);
			assertError(h, pattern);
		});
	}

	for (const outcome of ["success", "provider error", "rejection"]) {
		it(`Escape cancels immediately and ignores late ${outcome}`, async () => {
			const started = Promise.withResolvers();
			const pending = Promise.withResolvers();
			const h = setup({ complete: () => { started.resolve(); return pending.promise; } });
			const running = h.run();
			await started.promise;
			assert.deepEqual(h.executions(), []);
			assert.deepEqual(h.notifications, []);
			assert.ok(!h.events.includes("loader closed"));
			h.loaders[0].cancel();
			await running;
			assert.equal(h.ctx.modelRegistry.complete.mock.calls[0].arguments[2].signal.aborted, true);
			assertSourceUntouched(h);
			assert.deepEqual(h.executions(), []);
			assert.deepEqual(h.notifications, []);

			if (outcome === "rejection") pending.reject(new Error("Late rejection"));
			else pending.resolve(outcome === "success" ? answer("Too late") : { stopReason: "error", errorMessage: "Too late", content: [] });
			await settle();
			assertSourceUntouched(h);
			assert.deepEqual(h.executions(), []);
			assert.deepEqual(h.notifications, []);
			assert.equal(h.events.filter((event) => event === "loader closed").length, 1);
			assertLoaderDisposed(h);
		});
	}

	for (const [index, stage] of ["split", "start", "send-text", "focus", "send-keys"].entries()) {
		for (const failure of ["exit code", "rejection"]) {
			it(`reports the error without changing the source draft and stops after ${stage} ${failure}`, async () => {
				const h = setup({ exec: async (_binary, args) => {
					if (args[1] === stage) {
						if (failure === "rejection") throw new Error("CLI unavailable");
						return { code: 1, stdout: "", stderr: "Operation failed" };
					}
					return args[1] === "split" ? splitResult() : success();
				} });
				await h.run();
				assert.equal(h.executions().length, index + 1);
				assertSourceUntouched(h);
				assertError(h, failure === "rejection" ? /CLI unavailable/ : /Operation failed/);
				assert.doesNotMatch(h.notifications[0].text, /restored/);
				const detail = failure === "rejection" ? "CLI unavailable"
					: `herdr ${index === 0 || index === 2 ? "pane" : "agent"} ${stage} failed: Operation failed`;
				assert.equal(h.notifications[0].text, `Handoff failed: ${index > 0 ? `pane ${destination}: ` : ""}${detail}`);
				if (index > 2) assert.equal(h.executions()[2].args[3], "Continue the implementation.");
			});
		}
	}

	for (const stdout of ["not JSON", '{"result":{"pane":{}}}']) {
		it(`reports the error without changing the source draft when split returns ${stdout}`, async () => {
			const h = setup({ exec: async () => success(stdout) });
			await h.run();
			assert.equal(h.executions().length, 1);
			assertSourceUntouched(h);
			assertError(h, /invalid JSON|no pane ID/);
			assert.doesNotMatch(h.notifications[0].text, /restored/);
		});
	}
});

describe("Herdr CLI adapter", () => {
	function adapter(env = {}) {
		const exec = mock.fn(async () => success());
		const { createHerdr } = loadModules(env)("herdr");
		return { exec, herdr: createHerdr({ exec }) };
	}

	for (const direction of ["left", "right", "up", "down"]) {
		it(`splits ${direction} without focusing and returns the parsed pane ID`, async () => {
			const { exec, herdr } = adapter();
			exec.mock.mockImplementation(async () => splitResult());
			assert.equal(await herdr.splitPane(direction, cwd), destination);
			assert.equal(exec.mock.callCount(), 1);
			const [binary, args] = exec.mock.calls[0].arguments;
			assert.equal(binary, "herdr");
			assert.deepEqual(Array.from(args), ["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus"]);
		});
	}

	for (const [method, args, command] of [
		["startPiAgent", [destination, "handoff-test", "provider/org/model:variant"], ["agent", "start", "handoff-test", "--kind", "pi", "--pane", destination, "--", "--model", "provider/org/model:variant"]],
		["sendText", [destination, "--literal\n'quotes' $(nothing)"], ["pane", "send-text", destination, "--literal\n'quotes' $(nothing)"]],
		["sendKeys", [destination, "ctrl+shift+e"], ["agent", "send-keys", destination, "ctrl+shift+e"]],
		["focusAgent", [destination], ["agent", "focus", destination]],
	]) {
		it(`${method} invokes one command with literal arguments`, async () => {
			const { exec, herdr } = adapter({ HERDR_BIN_PATH: "/bin path/herdr" });
			assert.equal(await herdr[method](...args), undefined);
			assert.equal(exec.mock.callCount(), 1);
			const [binary, actual] = exec.mock.calls[0].arguments;
			assert.equal(binary, "/bin path/herdr");
			assert.deepEqual(Array.from(actual), command);
		});
	}

	for (const bin of [undefined, ""]) {
		it(`uses PATH when HERDR_BIN_PATH is ${JSON.stringify(bin)}`, async () => {
			const { exec, herdr } = adapter({ HERDR_BIN_PATH: bin });
			await herdr.focusAgent(destination);
			assert.equal(exec.mock.calls[0].arguments[0], "herdr");
		});
	}

	for (const [result, expected] of [
		[{ code: 3, stdout: "stdout detail", stderr: "  stderr detail\n" }, "herdr agent focus failed: stderr detail"],
		[{ code: 4, stdout: " stdout detail\n", stderr: " \n" }, "herdr agent focus failed: stdout detail"],
		[{ code: 5, stdout: "", stderr: "" }, "herdr agent focus failed: exit code 5"],
	]) {
		it(`reports CLI failure detail: ${expected}`, async () => {
			const { exec, herdr } = adapter();
			exec.mock.mockImplementation(async () => result);
			await assert.rejects(herdr.focusAgent(destination), { message: expected });
			assert.equal(exec.mock.callCount(), 1);
		});
	}

	it("propagates process execution errors without retrying", async () => {
		const { exec, herdr } = adapter();
		const error = new Error("spawn ENOENT");
		exec.mock.mockImplementation(async () => { throw error; });
		await assert.rejects(herdr.sendText(destination, "draft"), (actual) => actual === error);
		assert.equal(exec.mock.callCount(), 1);
	});

	for (const stdout of ["", "not JSON", "{broken", "null", "{}", '{"result":{}}', '{"result":{"pane":{}}}', ...[null, 12, false, ""].map((pane_id) => JSON.stringify({ result: { pane: { pane_id } } }))]) {
		it(`rejects unusable split output ${JSON.stringify(stdout)}`, async () => {
			const { exec, herdr } = adapter();
			exec.mock.mockImplementation(async () => success(stdout));
			await assert.rejects(herdr.splitPane("right", cwd), /herdr pane split returned (invalid JSON|no pane ID)/);
			assert.equal(exec.mock.callCount(), 1);
		});
	}
});
