const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const compiled = new Map();

// Compile the current implementation, not a duplicate of its logic. Each load
// gets isolated modules and environment variables without touching process.env.
function loadImplementation(entry, { env = {}, imports = {} } = {}) {
	const modules = new Map();
	function load(filename) {
		if (modules.has(filename)) return modules.get(filename).exports;
		if (!compiled.has(filename)) {
			const result = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
				fileName: filename,
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
			});
			compiled.set(filename, result.outputText);
		}
		const module = { exports: {} };
		modules.set(filename, module);
		const localRequire = (specifier) => {
			if (Object.hasOwn(imports, specifier)) return imports[specifier];
			if (specifier.startsWith("node:")) return require(specifier);
			if (specifier.startsWith("./")) return load(path.resolve(path.dirname(filename), `${specifier}.ts`));
			throw new Error(`Unmocked dependency: ${specifier}`);
		};
		const execute = vm.runInThisContext(
			`(function(exports, require, module, process) { ${compiled.get(filename)}\n})`,
			{ filename },
		);
		execute(module.exports, localRequire, module, { env });
		return module.exports;
	}
	return load(path.resolve(__dirname, entry));
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

// One event-loop turn drains the background promise chains. No timing sleeps.
async function settle() {
	await new Promise((resolve) => setImmediate(resolve));
}

function commandHarness({ env = {}, execHook, generateName, generateHandoffPrompt } = {}) {
	const calls = [];
	const generations = [];
	const notifications = [];
	const commands = new Map();
	const name = deferred();
	const prompt = deferred();
	const pi = {
		registerCommand(key, value) { commands.set(key, value); },
		getThinkingLevel() { return "high"; },
		async exec(bin, args) {
			calls.push({ bin, args });
			const override = await execHook?.(args, calls.length);
			if (override !== undefined) return override;
			let result = {};
			if (args[0] === "pane") result = { pane: { workspace_id: "workspace-source" } };
			if (args[0] === "tab" && args[1] === "create") {
				result = { root_pane: { pane_id: "pane-new" }, tab: { tab_id: "tab-new" } };
			}
			return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
		},
	};
	const ctx = {
		mode: "tui",
		cwd: "/work/project with spaces",
		model: { provider: "anthropic", id: "claude-source" },
		isIdle() { return true; },
		sessionManager: { getSessionId() { return "session-source"; } },
		ui: { notify(message, level) { notifications.push({ message, level }); } },
	};
	const extension = loadImplementation("index.ts", {
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane-source", ...env },
		imports: {
			"./openrouter": {
				generateName(context, task) {
					generations.push({ kind: "name", context, task });
					return generateName ? generateName(context, task) : name.promise;
				},
				generateHandoffPrompt(context, task) {
					generations.push({ kind: "prompt", context, task });
					return generateHandoffPrompt ? generateHandoffPrompt(context, task) : prompt.promise;
				},
			},
		},
	});
	extension.default(pi);
	return {
		pi, ctx, calls, generations, notifications, commands, name, prompt,
		run(command, args = "") { return commands.get(`herdr-${command}`).handler(args, ctx); },
	};
}

function assertErrorNotification(harness, message) {
	assert.deepEqual(harness.notifications, [{ message, level: "error" }]);
}

module.exports = { loadImplementation, deferred, settle, commandHarness, assertErrorNotification };
