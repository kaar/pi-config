// Run with: node --test agent/extensions/tests/openrouter-usage.test.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("../node_modules/typescript");
const { visibleWidth } = require("../node_modules/@earendil-works/pi-tui");

const compiled = ts.transpileModule(readFileSync(join(__dirname, "../openrouter-usage.ts"), "utf8"), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const env = { OPENROUTER_API_KEY: "inference-secret", OPENROUTER_MANAGEMENT_KEY: "management-secret" };
const usage = { usage: 4, usage_daily: 1, usage_weekly: 2, usage_monthly: 3 };
const credits = { total_credits: 100, total_usage: 25 };
const analytics = (data, truncated = false) => ({ data, metadata: { truncated } });
const row = (label, amount = 1) => ({ app: label, model: label, total_usage: amount, request_count: "12", tokens_total: "3400" });
const key = (name, overrides = {}) => ({ name, disabled: false, ...usage, limit: 10, limit_remaining: 7, limit_reset: "monthly", ...overrides });

function harness(respond, credentials = env) {
	const requests = [];
	const notifications = [];
	const timeouts = [];
	let command;
	const exports = {};
	runInNewContext(compiled, {
		exports,
		require(name) {
			assert.equal(name, "@earendil-works/pi-tui");
			return { visibleWidth };
		},
		process: { env: credentials },
		Error,
		AbortSignal: { timeout(ms) { timeouts.push(ms); return "timeout-signal"; } },
		async fetch(url, options) {
			const request = { endpoint: url.replace("https://openrouter.ai/api/v1/", ""), ...options };
			requests.push(request);
			const result = await respond(request);
			return { ok: result.status === undefined || result.status === 200, status: result.status || 200,
				json: async () => result.body === undefined ? { data: result.data } : result.body };
		},
	});
	exports.default({ registerCommand(name, definition) { assert.equal(name, "openrouter"); command = definition; } });
	return {
		requests, notifications, timeouts,
		completions: (prefix) => command.getArgumentCompletions(prefix),
		run: (args = "") => command.handler(args, { ui: { notify(text, level) { notifications.push({ text, level }); } } }),
	};
}

function assertNoSecrets(h) {
	for (const { text } of h.notifications) {
		assert.doesNotMatch(text, /inference-secret|management-secret/);
	}
}

test("summary uses separate credentials and preserves credit and usage reports", async () => {
	const h = harness(({ endpoint }) => ({ data: endpoint === "credits" ? credits : usage }));
	await h.run();
	assert.deepEqual(h.requests.map((r) => [r.endpoint, r.method, r.headers.Authorization]), [
		["credits", "GET", "Bearer management-secret"], ["key", "GET", "Bearer inference-secret"],
	]);
	assert.deepEqual(h.timeouts, [10000, 10000]);
	assert.equal(h.notifications[0].level, "info");
	assert.match(h.notifications[0].text, /Remaining: \$75\.0000/);
	assert.match(h.notifications[0].text, /Month: \$3\.0000/);
	assertNoSecrets(h);
});

test("summary preserves usage when credits fail", async () => {
	const h = harness(({ endpoint }) => endpoint === "credits" ? { status: 403 } : { data: usage });
	await h.run();
	assert.equal(h.notifications[0].level, "warning");
	assert.match(h.notifications[0].text, /Usage \(current key/);
	assert.match(h.notifications[0].text, /HTTP 403/);
});

for (const [credentials, section, missing] of [
	[{ OPENROUTER_API_KEY: env.OPENROUTER_API_KEY }, "Usage", "OPENROUTER_MANAGEMENT_KEY"],
	[{ OPENROUTER_MANAGEMENT_KEY: env.OPENROUTER_MANAGEMENT_KEY }, "Credits", "OPENROUTER_API_KEY"],
]) {
	test(`summary works with only ${Object.keys(credentials)[0]}`, async () => {
		const h = harness(({ endpoint }) => ({ data: endpoint === "credits" ? credits : usage }), credentials);
		await h.run();
		assert.equal(h.requests.length, 1);
		assert.equal(h.notifications[0].level, "warning");
		assert.match(h.notifications[0].text, new RegExp(section));
		assert.ok(h.notifications[0].text.includes(missing));
	});
}

test("missing credentials fail without any requests", async () => {
	for (const args of ["", "apps", "models", "keys"]) {
		const h = harness(() => assert.fail("unexpected request"), {});
		await h.run(args);
		assert.equal(h.notifications[0].level, "error");
		assert.equal(h.requests.length, 0);
	}
});

for (const [args, dimension, days] of [["apps", "app", 7], ["models 30", "model", 30], [" apps 1 ", "app", 1]]) {
	test(`${args.trim()} queries account analytics with the requested rolling period`, async () => {
		const h = harness(() => ({ data: analytics([row(null, 0.2), row("pi", 3)]) }), { OPENROUTER_MANAGEMENT_KEY: env.OPENROUTER_MANAGEMENT_KEY });
		await h.run(args);
		const request = h.requests[0];
		assert.equal(request.endpoint, "analytics/query");
		assert.equal(request.method, "POST");
		assert.equal(request.headers.Authorization, "Bearer management-secret");
		assert.equal(request.headers["Content-Type"], "application/json");
		const query = JSON.parse(request.body);
		assert.deepEqual(query.dimensions, [dimension]);
		assert.deepEqual(query.metrics, ["total_usage", "request_count", "tokens_total"]);
		assert.deepEqual(query.order_by, { field: "total_usage", direction: "desc" });
		assert.equal(query.filters, undefined);
		assert.equal(Date.parse(query.time_range.end) - Date.parse(query.time_range.start), days * 86400000);
		assert.equal(query.limit, 1000);
		assert.equal(h.notifications[0].level, "info");
		assert.match(h.notifications[0].text, /pi: \$3\.0000 +\| 12 requests \| 3,400 tokens/);
		assert.ok(h.notifications[0].text.indexOf("pi:") < h.notifications[0].text.indexOf("Unknown:"));
		assertNoSecrets(h);
	});
}

test("analytics align columns and omit timestamps and the attribution note", async () => {
	const h = harness(() => ({ data: analytics([
		{ ...row("pi", 0.329197), request_count: "132", tokens_total: "2486966" },
		{ ...row("Unknown", 0.242361), request_count: "122", tokens_total: "1843006" },
		{ ...row("ai-commit-message", 0.210666), request_count: "100", tokens_total: "654802" },
	]) }));
	await h.run("apps");
	assert.equal(h.notifications[0].text, [
		"Apps (account, last 7 days):",
		"    pi: $0.3292                | 132 requests | 2,486,966 tokens",
		"    Unknown: $0.2424           | 122 requests | 1,843,006 tokens",
		"    ai-commit-message: $0.2107 | 100 requests | 654,802 tokens",
	].join("\n"));
});

for (const command of ["apps", "models"]) {
	test(`${command} align both separators by terminal width, including wide labels`, async () => {
		const h = harness(() => ({ data: analytics([
			{ ...row("界界", 3), request_count: "12345" },
			{ ...row("short", 2), request_count: "1" },
			row("a-longer-name", 1),
		]) }));
		await h.run(command);
		const lines = h.notifications[0].text.split("\n").slice(1);
		const positions = lines.map((line) => {
			const cells = line.split("|");
			return [visibleWidth(cells[0]), visibleWidth(cells[0] + "|" + cells[1])];
		});
		assert.ok(positions.every((position) => position[0] === positions[0][0] && position[1] === positions[0][1]));
		assert.doesNotMatch(h.notifications[0].text, /\d{4}-\d{2}-\d{2}T|Unknown means/);
	});
}

test("empty, capped, and truncated analytics have explicit notices", async () => {
	let h = harness(() => ({ data: analytics([]) }));
	await h.run("apps");
	assert.match(h.notifications[0].text, /No usage/);
	h = harness(() => ({ data: analytics(Array.from({ length: 21 }, (_, i) => row(`app-${i}`, i)), true) }));
	await h.run("apps");
	assert.match(h.notifications[0].text, /top 20 of 21/);
	assert.match(h.notifications[0].text, /API truncated/);
	assert.doesNotMatch(h.notifications[0].text, /app-0:/);
});

for (const data of [
	analytics([{ ...row("pi"), total_usage: "1" }]),
	analytics([{ ...row("pi"), total_usage: Infinity }]),
	analytics([{ ...row("pi"), request_count: "garbage" }]),
	analytics([{ ...row("pi"), tokens_total: null }]),
	analytics([{ ...row("pi"), request_count: -1 }]),
	analytics([{ ...row("pi"), tokens_total: "9007199254740992" }]),
	analytics([{ ...row("pi"), app: {} }]),
	analytics([null]),
	{ data: [], metadata: {} },
	{ data: null, metadata: { truncated: false } },
]) {
	test(`rejects malformed analytics ${JSON.stringify(data)}`, async () => {
		const h = harness(() => ({ data }));
		await h.run("apps");
		assert.equal(h.notifications[0].level, "error");
		assert.match(h.notifications[0].text, /invalid/);
	});
}

test("keys paginate, include disabled keys, sort by usage, and do not show key labels or hashes", async () => {
	const batches = [
		[key("small", { usage: 1, limit: null, limit_remaining: null })],
		[key("large", { usage: 5, disabled: true, label: "private-label", hash: "private-hash" })],
		[],
	];
	const h = harness(() => ({ data: batches.shift() }));
	await h.run("keys");
	assert.deepEqual(h.requests.map((r) => r.endpoint), [
		"keys?include_disabled=true&offset=0", "keys?include_disabled=true&offset=1", "keys?include_disabled=true&offset=2",
	]);
	assert.ok(h.requests.every((r) => r.method === "GET" && r.headers.Authorization === "Bearer management-secret"));
	const { text, level } = h.notifications[0];
	assert.equal(level, "info");
	assert.match(text, /default workspace/);
	assert.ok(text.indexOf("large (disabled)") < text.indexOf("small"));
	assert.match(text, /\$7\.0000 remaining of \$10\.0000 \(monthly\)/);
	assert.match(text, /Budget: unlimited/);
	assert.doesNotMatch(text, /private-label|private-hash/);
	assertNoSecrets(h);
});

test("empty keys report and malformed key budget", async () => {
	let h = harness(() => ({ data: [] }));
	await h.run("keys");
	assert.match(h.notifications[0].text, /No keys/);
	const batches = [[key("broken", { limit_remaining: null })], []];
	h = harness(() => ({ data: batches.shift() }));
	await h.run("keys");
	assert.equal(h.notifications[0].level, "error");
	assert.match(h.notifications[0].text, /invalid key budget/);
});

test("invalid command arguments and help never call the API", async () => {
	for (const args of ["help", "bogus", "apps 0", "apps 31", "apps 1.5", "apps 1e1", "models NaN", "keys 7", "apps 7 extra"]) {
		const h = harness(() => assert.fail("unexpected request"));
		await h.run(args);
		assert.equal(h.requests.length, 0);
		assert.equal(h.notifications[0].level, args === "help" ? "info" : "error");
		assert.match(h.notifications[0].text, /\/openrouter apps/);
	}
	const h = harness(() => assert.fail("unexpected request"));
	assert.deepEqual(Array.from(h.completions("a"), (item) => item.value), ["apps"]);
});

test("HTTP, missing data, malformed summary amounts, and network errors are reported", async () => {
	for (const result of [{ status: 401 }, { body: {} }, { data: { ...credits, total_usage: null } }]) {
		const h = harness(() => result, { OPENROUTER_MANAGEMENT_KEY: env.OPENROUTER_MANAGEMENT_KEY });
		await h.run();
		assert.equal(h.notifications[0].level, "error");
		assertNoSecrets(h);
	}
	const h = harness(() => { throw new Error("Request timed out."); });
	await h.run("models");
	assert.equal(h.notifications[0].level, "error");
	assert.match(h.notifications[0].text, /timed out/);
});
