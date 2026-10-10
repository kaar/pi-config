const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadImplementation } = require("./test-support.cjs");

function harness({ env = {}, results = [] } = {}) {
	const calls = [];
	const { createHerdr } = loadImplementation("cli.ts", { env });
	const herdr = createHerdr({
		async exec(bin, args) {
			calls.push({ bin, args });
			const result = results.shift();
			if (result instanceof Error) throw result;
			return result ?? { code: 0, stdout: "", stderr: "" };
		},
	});
	return { herdr, calls, env };
}

const json = (result) => ({ code: 0, stdout: JSON.stringify({ result }), stderr: "" });
const pane = json({ pane: { workspace_id: "workspace-a" } });
const tab = json({ root_pane: { pane_id: "pane-b" }, tab: { tab_id: "tab-b" } });

for (const [label, env, bin] of [
	["default", {}, "herdr"],
	["empty override", { HERDR_BIN_PATH: "" }, "herdr"],
	["custom path", { HERDR_BIN_PATH: "/Applications/Herdr App/bin/herdr" }, "/Applications/Herdr App/bin/herdr"],
]) {
	test(`tabCreate uses ${label} binary and creates an unfocused tab in the current workspace`, async () => {
		const h = harness({ env, results: [pane, tab] });
		assert.deepEqual(await h.herdr.tabCreate("/work/with spaces"), { paneId: "pane-b", tabId: "tab-b" });
		assert.deepEqual(h.calls, [
			{ bin, args: ["pane", "current", "--current"] },
			{ bin, args: ["tab", "create", "--workspace", "workspace-a", "--cwd", "/work/with spaces", "--no-focus"] },
		]);
	});
}

test("the binary is captured when the client is created", async () => {
	const h = harness({ env: { HERDR_BIN_PATH: "initial-herdr" } });
	h.env.HERDR_BIN_PATH = "changed-herdr";
	await h.herdr.tabRename("tab-b", "name");
	assert.equal(h.calls[0].bin, "initial-herdr");
});

for (const fork of [undefined, "saved-session-id", ""]) {
	test(`agentStartPi ${fork === undefined ? "starts fresh" : `passes fork ${JSON.stringify(fork)}`} with model and thinking arguments after --`, async () => {
		const h = harness();
		await h.herdr.agentStartPi({ pane: "pane-b", name: "task-name", model: "provider/model", thinking: "off", fork });
		assert.deepEqual(h.calls, [{ bin: "herdr", args: [
			"agent", "start", "task-name", "--kind", "pi", "--pane", "pane-b", "--",
			"--model", "provider/model", "--thinking", "off",
			...(fork === undefined ? [] : ["--fork", fork]),
		] }]);
	});
}

for (const [method, args, expected] of [
	["tabRename", ["tab-b", "two words"], ["tab", "rename", "tab-b", "two words"]],
	["agentRename", ["pane-b", "new-name"], ["agent", "rename", "pane-b", "new-name"]],
	["agentPrompt", ["pane-b", "  line one\n'quoted' $(do-not-run); --flag  "], ["agent", "prompt", "pane-b", "  line one\n'quoted' $(do-not-run); --flag  "]],
]) {
	test(`${method} passes identifiers and text as separate unchanged arguments`, async () => {
		const h = harness();
		assert.equal(await h.herdr[method](...args), undefined);
		assert.deepEqual(h.calls, [{ bin: "herdr", args: expected }]);
	});
}

for (const [label, result, detail] of [
	["stderr first", { code: 1, stderr: "  stderr detail\n", stdout: "stdout detail" }, "stderr detail"],
	["stdout fallback", { code: 2, stderr: " \n", stdout: " stdout detail\n" }, "stdout detail"],
	["exit code fallback", { code: 7, stderr: "", stdout: " " }, "exit code 7"],
]) {
	test(`CLI failures report ${label} without retrying`, async () => {
		const h = harness({ results: [result] });
		await assert.rejects(h.herdr.agentPrompt("pane-b", "task"), { message: `herdr agent prompt failed: ${detail}` });
		assert.equal(h.calls.length, 1);
	});
}

test("execution rejections propagate unchanged", async () => {
	const failure = new Error("binary not found");
	const h = harness({ results: [failure] });
	await assert.rejects(h.herdr.tabRename("tab-b", "name"), (error) => error === failure);
	assert.equal(h.calls.length, 1);
});

for (const stage of ["pane current", "tab create"]) {
	test(`tabCreate stops on a ${stage} CLI failure`, async () => {
		const failure = { code: 1, stdout: "", stderr: "unavailable" };
		const h = harness({ results: stage === "pane current" ? [failure] : [pane, failure] });
		await assert.rejects(h.herdr.tabCreate("/work"), { message: `herdr ${stage} failed: unavailable` });
		assert.equal(h.calls.length, stage === "pane current" ? 1 : 2);
	});
	for (const stdout of ["", "not-json", "{unfinished"]) {
		test(`tabCreate reports invalid JSON from ${stage}: ${JSON.stringify(stdout)}`, async () => {
			const invalid = { code: 0, stdout, stderr: "" };
			const h = harness({ results: stage === "pane current" ? [invalid] : [pane, invalid] });
			await assert.rejects(h.herdr.tabCreate("/work"), (error) => {
				assert.equal(error.message, `herdr ${stage} returned invalid JSON.`);
				assert.ok(error.cause instanceof SyntaxError);
				return true;
			});
			assert.equal(h.calls.length, stage === "pane current" ? 1 : 2);
		});
	}
}

test("successful mutation commands do not require JSON output", async () => {
	const h = harness({ results: [{ code: 0, stdout: "renamed", stderr: "warning" }] });
	await h.herdr.agentRename("pane-b", "name");
	assert.equal(h.calls.length, 1);
});
