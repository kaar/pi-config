const assert = require("node:assert/strict");
const { test } = require("node:test");
const { commandHarness, deferred, settle, assertErrorNotification } = require("./test-support.cjs");

const DEFAULT_GOAL = "Preserve the current context, decisions, and agreed next steps, then wait for my instructions.";
const argsOf = (h) => h.calls.map(({ args }) => args);
const renamesOf = (h) => argsOf(h).filter((args) => args[1] === "rename");
const promptsOf = (h) => argsOf(h).filter((args) => args[1] === "prompt");
const label = (command) => command === "fork" ? "Fork" : "Handoff";
const namingWarning = (detail) => ({ message: `Automatic session naming failed: Error: ${detail}`, level: "warning" });

// Handoff awaits prompt generation and submission before returning. Shared
// tests resolve the prompt up front so the command can complete; the deferred
// settles in order regardless of when generation starts.
function prepare(h, command) {
	if (command === "handoff") h.prompt.resolve("generated prompt");
}

function assertLaunch(h, command, { model = "anthropic/claude-source", thinking = "high", session = "session-source" } = {}) {
	assert.deepEqual(argsOf(h).slice(0, 2), [
		["pane", "current", "--current"],
		["tab", "create", "--workspace", "workspace-source", "--cwd", "/work/project with spaces", "--no-focus"],
	]);
	const launch = h.calls[2].args;
	assert.deepEqual(launch.slice(0, 2), ["agent", "start"]);
	assert.match(launch[2], command === "fork" ? /^fork-[a-f0-9]{26}$/ : /^handoff-[a-f0-9]{24}$/);
	assert.deepEqual(launch.slice(3), [
		"--kind", "pi", "--pane", "pane-new", "--", "--model", model, "--thinking", thinking,
		...(command === "fork" ? ["--fork", session] : []),
	]);
}

test("loading registers only the two commands and performs no external work", () => {
	const h = commandHarness();
	assert.deepEqual([...h.commands.keys()].sort(), ["herdr-fork", "herdr-handoff"]);
	for (const command of h.commands.values()) {
		assert.equal(typeof command.handler, "function");
		assert.ok(command.description.length > 0);
	}
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.generations, []);
	assert.deepEqual(h.notifications, []);
});

const guards = [
	...["rpc", "json", "print"].map((mode) => ({ label: `${mode} mode`, update: (h) => { h.ctx.mode = mode; }, message: "This command requires interactive mode." })),
	...[undefined, "", "0", "true"].map((value) => ({ label: `HERDR_ENV=${value}`, env: { HERDR_ENV: value }, message: "Run this command inside a Herdr pane." })),
	...[undefined, "", " \t\n"].map((value) => ({ label: `pane ID ${JSON.stringify(value)}`, env: { HERDR_PANE_ID: value }, message: "Run this command inside a Herdr pane." })),
	{ label: "busy session", update: (h) => { h.ctx.isIdle = () => false; }, message: "Wait until Pi is idle before running this command." },
	{ label: "missing model", update: (h) => { h.ctx.model = undefined; }, message: "No model selected." },
];

for (const command of ["fork", "handoff"]) {
	for (const guard of guards) {
		test(`${command} rejects ${guard.label} before launch or generation`, async () => {
			const h = commandHarness({ env: guard.env });
			guard.update?.(h);
			h.ctx.sessionManager.getSessionId = () => { throw new Error("must not read session"); };
			h.pi.getThinkingLevel = () => { throw new Error("must not read thinking level"); };
			await h.run(command, "task");
			assertErrorNotification(h, guard.message);
			assert.deepEqual(h.calls, []);
			assert.deepEqual(h.generations, []);
		});
	}

	test(`${command} snapshots launch settings before waiting for tab creation`, async () => {
		const gate = deferred();
		const h = commandHarness({ execHook: (args) => args[0] === "pane" ? gate.promise : undefined });
		prepare(h, command);
		const running = h.run(command);
		h.ctx.cwd = "/changed";
		h.ctx.model = { provider: "changed", id: "changed" };
		h.ctx.sessionManager.getSessionId = () => "changed-session";
		h.pi.getThinkingLevel = () => "off";
		gate.resolve(undefined);
		await running;
		assertLaunch(h, command);
	});

	test(`${command} waits for agent startup before generating or submitting work`, async () => {
		const gate = deferred();
		const h = commandHarness({ execHook: (args) => args[0] === "agent" && args[1] === "start" ? gate.promise : undefined });
		prepare(h, command);
		let returned = false;
		const running = h.run(command, "task").then(() => { returned = true; });
		await settle();
		assert.equal(h.calls.length, 3);
		assert.equal(returned, false);
		assert.deepEqual(h.generations, []);
		gate.resolve(undefined);
		await running;
		assert.equal(returned, true);
		assert.deepEqual(h.generations.map(({ kind }) => kind), command === "fork" ? ["name"] : ["name", "prompt"]);
	});

	for (const [stage, callCount] of [["pane current", 1], ["tab create", 2], ["agent start", 3]]) {
		test(`${command} reports ${stage} failure and stops without retry or cleanup`, async () => {
			const h = commandHarness({ execHook: (args) => args.slice(0, 2).join(" ") === stage ? { code: 1, stdout: "", stderr: "broken" } : undefined });
			prepare(h, command);
			await h.run(command, "task");
			await settle();
			assert.equal(h.calls.length, callCount);
			assert.deepEqual(h.generations, []);
			assertErrorNotification(h, `${label(command)} failed: Error: herdr ${stage} failed: broken`);
		});
	}

	test(`${command} renames the agent then the tab without notifying`, async () => {
		const gate = deferred();
		const h = commandHarness({ execHook: (args) => args[0] === "agent" && args[1] === "rename" ? gate.promise : undefined });
		prepare(h, command);
		await h.run(command);
		h.name.resolve("generated-title");
		await settle();
		assert.deepEqual(renamesOf(h), [["agent", "rename", "pane-new", "generated-title"]]);
		assert.deepEqual(h.notifications, []);
		gate.resolve(undefined);
		await settle();
		assert.deepEqual(renamesOf(h), [
			["agent", "rename", "pane-new", "generated-title"],
			["tab", "rename", "tab-new", "generated-title"],
		]);
		assert.deepEqual(h.notifications, []);
	});

	for (const [stage, detail, extraCalls] of [
		["generation", "name unavailable", 0],
		["agent rename", "herdr agent rename failed: rename failed", 1],
		["tab rename", "herdr tab rename failed: rename failed", 2],
	]) {
		test(`${command} warns about naming ${stage} failure without retrying`, async () => {
			const h = commandHarness({ execHook: (args) => args.slice(0, 2).join(" ") === stage ? { code: 1, stdout: "", stderr: "rename failed" } : undefined });
			prepare(h, command);
			await h.run(command);
			const launchCalls = h.calls.length;
			if (stage === "generation") h.name.reject(new Error("name unavailable"));
			else h.name.resolve("generated-title");
			await settle();
			assert.deepEqual(h.notifications, [namingWarning(detail)]);
			assert.equal(h.calls.length, launchCalls + extraCalls);
		});
	}
}

for (const task of ["", " \t\n", "  fix tests\nthen review  "]) {
	test(`fork handles optional task ${JSON.stringify(task)} and returns with naming pending`, async () => {
		const h = commandHarness();
		await h.run("fork", task);
		assertLaunch(h, "fork");
		assert.deepEqual(argsOf(h).slice(3), task.trim() ? [["agent", "prompt", "pane-new", task.trim()]] : []);
		assert.deepEqual(h.generations, [{ kind: "name", context: h.ctx, task: task.trim() }]);
		assert.deepEqual(h.notifications, []);
	});
}

test("fork starts name generation before waiting for task submission", async () => {
	const gate = deferred();
	const h = commandHarness({ execHook: (args) => args[1] === "prompt" ? gate.promise : undefined });
	let returned = false;
	const running = h.run("fork", "task").then(() => { returned = true; });
	await settle();
	assert.equal(h.calls.length, 4);
	assert.equal(returned, false);
	assert.deepEqual(h.generations, [{ kind: "name", context: h.ctx, task: "task" }]);
	gate.resolve(undefined);
	await running;
	assert.equal(returned, true);
	assert.equal(h.generations.length, 1);
});

test("fork reports submission failure without retrying the task and still renames", async () => {
	const h = commandHarness({ execHook: (args) => args[1] === "prompt" ? { code: 1, stdout: "", stderr: "delivery unknown" } : undefined });
	await h.run("fork", "task");
	assert.equal(h.calls.length, 4);
	assert.deepEqual(h.generations.map(({ kind }) => kind), ["name"]);
	assertErrorNotification(h, "Fork failed: Error: herdr agent prompt failed: delivery unknown");
	h.name.resolve("still-renamed");
	await settle();
	assert.deepEqual(renamesOf(h), [
		["agent", "rename", "pane-new", "still-renamed"],
		["tab", "rename", "tab-new", "still-renamed"],
	]);
	assert.equal(h.notifications.length, 1);
});

for (const goal of ["", " \t\n", "  implement phase one  "]) {
	test(`handoff starts a fresh session with goal ${JSON.stringify(goal)} and awaits prompt generation and submission`, async () => {
		const h = commandHarness();
		let returned = false;
		const running = h.run("handoff", goal).then(() => { returned = true; });
		await settle();
		assertLaunch(h, "handoff");
		assert.equal(h.calls.length, 3);
		assert.equal(returned, false);
		assert.deepEqual(h.generations, [
			{ kind: "name", context: h.ctx, task: goal.trim() || DEFAULT_GOAL },
			{ kind: "prompt", context: h.ctx, task: goal.trim() || DEFAULT_GOAL },
		]);
		h.prompt.resolve("## Context\nGenerated task");
		await running;
		assert.equal(returned, true);
		assert.deepEqual(argsOf(h).slice(3), [["agent", "prompt", "pane-new", "## Context\nGenerated task"]]);
		assert.deepEqual(h.notifications, []);
	});
}

for (const first of ["name", "prompt"]) {
	test(`handoff processes ${first} independently while the other generation remains pending`, async () => {
		const h = commandHarness();
		const running = h.run("handoff", "goal");
		await settle();
		if (first === "name") h.name.resolve("new-title");
		else h.prompt.resolve("## Context\nGenerated task");
		await settle();
		assert.deepEqual(argsOf(h).slice(3), first === "name" ? [
			["agent", "rename", "pane-new", "new-title"], ["tab", "rename", "tab-new", "new-title"],
		] : [["agent", "prompt", "pane-new", "## Context\nGenerated task"]]);
		if (first === "name") h.prompt.resolve("## Context\nGenerated task");
		else h.name.resolve("new-title");
		await running;
		await settle();
		assert.equal(h.calls.length, 6);
		assert.equal(promptsOf(h).length, 1);
		assert.deepEqual(h.notifications, []);
	});
}

for (const stage of ["generation", "submission"]) {
	test(`handoff ${stage} failure reports the error and does not prevent naming`, async () => {
		const h = commandHarness({ execHook: (args) => stage === "submission" && args[1] === "prompt" ? { code: 1, stdout: "", stderr: "delivery unknown" } : undefined });
		const running = h.run("handoff", "goal");
		await settle();
		if (stage === "generation") h.prompt.reject(new Error("generation unavailable"));
		else h.prompt.resolve("generated prompt");
		await running;
		assertErrorNotification(h, `Handoff failed: Error: ${stage === "generation" ? "generation unavailable" : "herdr agent prompt failed: delivery unknown"}`);
		assert.equal(promptsOf(h).length, stage === "generation" ? 0 : 1);
		h.name.resolve("still-renamed");
		await settle();
		assert.deepEqual(renamesOf(h), [
			["agent", "rename", "pane-new", "still-renamed"],
			["tab", "rename", "tab-new", "still-renamed"],
		]);
		assert.equal(h.notifications.length, 1);
	});
}

test("handoff naming failure warns but does not prevent prompt delivery", async () => {
	const h = commandHarness();
	const running = h.run("handoff", "goal");
	await settle();
	h.name.reject(new Error("name unavailable"));
	h.prompt.resolve("continuation");
	await running;
	await settle();
	assert.deepEqual(argsOf(h).slice(3), [["agent", "prompt", "pane-new", "continuation"]]);
	assert.deepEqual(h.notifications, [namingWarning("name unavailable")]);
});
