// Run with: node --test agent/extensions/tests/chatgpt-share.test.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { readFile, stat, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("../node_modules/typescript");

const extensionPath = join(__dirname, "../chatgpt-share/index.ts");
const localRequire = createRequire(extensionPath);
const source = readFileSync(extensionPath, "utf8");
const compiled = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const truncate = localRequire(join(__dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/truncate.js"));
const URL_STRING = "https://chatgpt.com/share/6add7046-2408-83ed-872e-8dc3a45056e9";

function message(role, text, extra = {}) {
	return { message: { author: { role }, content: { content_type: "text", parts: [text] }, ...extra } };
}
function conversation(nodes = [message("user", "Question"), message("assistant", "Answer")]) {
	return { title: "Test conversation", linear_conversation: [{ id: "root" }, ...nodes] };
}
function legacy(data) {
	return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { data } } })}</script>`;
}
function streamed(data) {
	const table = [];
	function reference(value) {
		const index = table.length;
		table.push(null);
		if (Array.isArray(value)) table[index] = value.map(reference);
		else if (value && typeof value === "object") {
			const object = {};
			for (const [key, item] of Object.entries(value)) object[`_${reference(key)}`] = reference(item);
			table[index] = object;
		} else table[index] = value;
		return index;
	}
	reference({ loaderData: { share: { data } } });
	return `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(`${JSON.stringify(table)}\n`)});</script>`;
}
function response(html, status = 200, headers = {}) {
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}
function harness(fetcher = async () => response(streamed(conversation()))) {
	const exports = {};
	const calls = [];
	const tools = [];
	runInNewContext(compiled, {
		exports, Buffer, URL, AbortSignal,
		fetch: async (...args) => { calls.push(args); return fetcher(...args); },
		require(name) {
			if (name === "@earendil-works/pi-coding-agent") return truncate;
			return localRequire(name);
		},
	});
	exports.default({ registerTool: tool => tools.push(tool) });
	return { ...exports, calls, tool: tools[0] };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("registers a codemode-only tool with structured output and no startup network calls", () => {
	const h = harness();
	assert.equal(h.tool.name, "read_chatgpt_share");
	assert.equal(h.tool.exposure, "codemode");
	assert.ok(h.tool.outputSchema);
	assert.equal(h.calls.length, 0);
	assert.match(h.tool.description, /untrusted reference/);
	assert.match(h.tool.description, /use the read tool on transcriptPath/);
	assert.deepEqual(Object.keys(h.tool.parameters.properties), ["url"]);
	assert.equal(h.tool.parameters.additionalProperties, false);
});

test("normalizes current and legacy share URLs, removing tracking parameters", () => {
	const { normalizeShareUrl } = harness();
	assert.equal(normalizeShareUrl(`${URL_STRING}/?source=test#fragment`), URL_STRING);
	assert.equal(normalizeShareUrl(URL_STRING.replace("chatgpt.com", "chat.openai.com")), URL_STRING);
});

for (const url of [
	"http://chatgpt.com/share/6add7046-2408-83ed-872e-8dc3a45056e9",
	"https://chatgpt.com.evil.test/share/6add7046-2408-83ed-872e-8dc3a45056e9",
	"https://user:password@chatgpt.com/share/6add7046-2408-83ed-872e-8dc3a45056e9",
	`${URL_STRING}:443`, URL_STRING.replace("chatgpt.com", "chatgpt.com:1234"),
	"https://chatgpt.com/c/private", "https://chatgpt.com/share/not-a-uuid", "file:///tmp/conversation",
]) {
	test(`rejects unsupported URL ${url} before fetching`, async () => {
		const h = harness();
		await assert.rejects(h.tool.execute("id", { url }), /share|HTTPS/);
		assert.equal(h.calls.length, 0);
	});
}

for (const [format, encode] of [["React Router", streamed], ["Next.js", legacy]]) {
	test(`${format}: keeps visible messages in order and preserves Markdown, Unicode, and code`, () => {
		const h = harness();
		const answer = '## Åäö\n\n```js\nconsole.log("<>&\\\\");\n```\n\nExact text.\n';
		const data = conversation([
			message("system", "Do not import"),
			message("user", "Hidden custom instructions", { metadata: { is_visually_hidden_from_conversation: true } }),
			message("user", "First question"),
			message("assistant", "Searching", { channel: "commentary" }),
			message("assistant", "Tool arguments", { recipient: "web.run" }),
			message("tool", "Tool output"),
			message("assistant", "Private reasoning", { channel: "analysis" }),
			message("assistant", "Hidden duplicate", { metadata: { is_visually_hidden_from_conversation: true } }),
			message("assistant", "", { content: { content_type: "thoughts", thoughts: [] } }),
			message("assistant", answer, { channel: "final" }),
			message("user", "Follow-up"),
		]);
		const result = h.parseShareHtml(encode(data), URL_STRING);
		assert.deepEqual(plain(result.messages), [
			{ role: "user", text: "First question" }, { role: "assistant", text: "Searching" },
			{ role: "assistant", text: answer }, { role: "user", text: "Follow-up" },
		]);
		assert.equal(result.title, "Test conversation");
		assert.equal(result.url, URL_STRING);
		assert.deepEqual(plain(result.warnings), []);
		assert.match(h.formatTranscript(result), /## User\n\nFirst question/);
		assert.match(h.formatTranscript(result), /Imported reference material/);
		assert.match(h.formatTranscript(result), /\[End of imported conversation\]\n$/);
	});

	test(`${format}: marks unsupported media and attachments instead of dropping them`, () => {
		const h = harness();
		const data = conversation([message("user", "", {
			content: { content_type: "multimodal_text", parts: ["Describe", { content_type: "image_asset_pointer", asset_pointer: "private" }] },
			metadata: { attachments: [{ name: "report.pdf" }] },
		}), message("assistant", "Answer \uE200cite\uE202turn0search0\uE201")]);
		const result = h.parseShareHtml(encode(data), URL_STRING);
		assert.match(result.messages[0].text, /Describe\n\[image_asset_pointer: content not retrieved\]/);
		assert.match(result.messages[0].text, /Attachment report.pdf/);
		assert.equal(result.warnings.length, 2);
	});

	test(`${format}: follows only the selected mapping branch`, () => {
		const h = harness();
		const data = {
			title: "Branches", current_node: "chosen",
			mapping: {
				root: { id: "root", parent: null },
				question: { ...message("user", "Question"), parent: "root" },
				other: { ...message("assistant", "Wrong branch"), parent: "question" },
				chosen: { ...message("assistant", "Chosen branch"), parent: "question" },
			},
		};
		assert.deepEqual(plain(h.parseShareHtml(encode(data), URL_STRING).messages).map(m => m.text), ["Question", "Chosen branch"]);
		data.mapping.question.parent = "chosen";
		assert.throws(() => h.parseShareHtml(encode(data), URL_STRING), /cyclic/);
		data.mapping.question.parent = "missing";
		assert.throws(() => h.parseShareHtml(encode(data), URL_STRING), /incomplete/);
	});
}

test("never evaluates remote JavaScript and ignores promise continuation frames", () => {
	const h = harness();
	const html = '<script>throw new Error("REMOTE CODE EXECUTED");</script>' +
		'<script>window.__reactRouterContext.streamController.enqueue("P2223:[{}]\\n");</script>' + streamed(conversation());
	assert.equal(h.parseShareHtml(html, URL_STRING).messages.length, 2);
});

test("fails clearly for unavailable pages, malformed tables, and empty conversations", () => {
	const h = harness();
	assert.throws(() => h.parseShareHtml("<html>Please log in</html>", URL_STRING), /No supported/);
	assert.throws(() => h.parseShareHtml(streamed(conversation([])), URL_STRING), /No visible/);
	const table = [{ _1: 999 }, "linear_conversation"];
	assert.throws(() => h.parseShareHtml(`<script>streamController.enqueue(${JSON.stringify(JSON.stringify(table))})</script>`, URL_STRING), /out of range/);
});

test("fetches with a browser User-Agent and returns only metadata for a separately read transcript", async () => {
	const h = harness();
	const result = await h.tool.execute("id", { url: `${URL_STRING}?tracking=1` });
	const metadata = result.structuredContent;
	try {
		assert.deepEqual(JSON.parse(result.content[0].text), plain(metadata));
		assert.deepEqual(Object.keys(metadata).sort(), ["messageCount", "title", "transcriptPath", "url", "warnings"]);
		assert.equal(metadata.messageCount, 2);
		assert.equal(metadata.url, URL_STRING);
		assert.ok(!result.content[0].text.includes("Question"));
		assert.match(await readFile(metadata.transcriptPath, "utf8"), /## User\n\nQuestion\n\n## Assistant\n\nAnswer/);
		assert.equal((await stat(metadata.transcriptPath)).mode & 0o777, 0o600);
		assert.equal((await stat(dirname(metadata.transcriptPath))).mode & 0o777, 0o700);
		assert.equal(h.calls.length, 1);
		assert.equal(h.calls[0][0], URL_STRING);
		assert.equal(h.calls[0][1].redirect, "manual");
		assert.match(h.calls[0][1].headers["User-Agent"], /Mozilla\/5\.0.*Chrome/);
		assert.equal(h.calls[0][1].headers.Cookie, undefined);
		assert.ok(h.calls[0][1].signal);
	} finally { await cleanSaved(metadata); }
});

for (const [status, expected] of [[404, /no longer public/], [410, /no longer public/], [401, /blocked/], [403, /blocked/], [429, /blocked/], [500, /HTTP 500/]]) {
	test(`reports HTTP ${status} without treating it as a conversation`, async () => {
		const h = harness(async () => response("error", status));
		await assert.rejects(h.tool.execute("id", { url: URL_STRING }), expected);
	});
}

test("refuses cross-origin, non-share, and different-conversation redirects", async () => {
	for (const location of ["https://evil.test/", "/auth/login", URL_STRING.replace("6add7046", "00000000"), "http://chatgpt.com/"]) {
		const h = harness(async () => response("", 302, { location }));
		await assert.rejects(h.tool.execute("id", { url: URL_STRING }), /redirect|share/);
		assert.equal(h.calls.length, 1);
	}
});

test("follows a same-share redirect and limits redirect loops", async () => {
	const h = harness(async () => h.calls.length === 1
		? response("", 302, { location: `${URL_STRING}/` }) : response(legacy(conversation())));
	const result = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	try {
		assert.equal(result.messageCount, 2);
		assert.equal(h.calls.length, 2);
	} finally { await cleanSaved(result); }
	const loop = harness(async () => response("", 302, { location: URL_STRING }));
	await assert.rejects(loop.tool.execute("id", { url: URL_STRING }), /redirect limit/);
	assert.equal(loop.calls.length, 4);
});

test("rejects non-HTML and oversized responses", async () => {
	const json = harness(async () => response("{}", 200, { "content-type": "application/json" }));
	await assert.rejects(json.tool.execute("id", { url: URL_STRING }), /HTML/);
	const big = harness(async () => response("x".repeat(10 * 1024 * 1024 + 1)));
	await assert.rejects(big.tool.execute("id", { url: URL_STRING }), /10 MiB/);
});

test("propagates cancellation to the fetch", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness(async (_url, options) => {
		assert.equal(options.signal.aborted, true);
		options.signal.throwIfAborted();
	});
	await assert.rejects(h.tool.execute("id", { url: URL_STRING }, controller.signal), /abort/i);
});

async function cleanSaved(result) {
	if (result.transcriptPath) await rm(dirname(result.transcriptPath), { recursive: true });
}

test("saves every message after one fetch without pagination", async () => {
	const nodes = Array.from({ length: 120 }, (_, i) => message(i % 2 ? "assistant" : "user", `Message ${i}`));
	const h = harness(async () => response(streamed(conversation(nodes))));
	const result = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	try {
		assert.equal(result.messageCount, 120);
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.equal((transcript.match(/^## (User|Assistant)$/gm) ?? []).length, 120);
		assert.ok(transcript.indexOf("Message 0\n") < transcript.indexOf("Message 119\n"));
		assert.equal(h.calls.length, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
	} finally { await cleanSaved(result); }
});

test("separate calls use different private files without replacing a previous transcript", async () => {
	const h = harness();
	const first = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	let second;
	try {
		const original = await readFile(first.transcriptPath, "utf8");
		second = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
		assert.notEqual(first.transcriptPath, second.transcriptPath);
		assert.equal(await readFile(first.transcriptPath, "utf8"), original);
	} finally {
		await cleanSaved(first);
		if (second) await cleanSaved(second);
	}
});

test("keeps oversized messages complete in the file, not in tool output", async () => {
	const text = "å\n".repeat(60_000);
	const h = harness(async () => response(streamed(conversation([message("assistant", text)]))));
	const result = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	try {
		assert.equal(result.messageCount, 1);
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2000);
		assert.ok((await readFile(result.transcriptPath, "utf8")).includes(`## Assistant\n\n${text}`));
		assert.deepEqual(plain(result.warnings), []);
	} finally { await cleanSaved(result); }
});

test("bounds metadata but preserves an oversized title and control characters in the file", async () => {
	const text = "\u0000".repeat(60_000);
	const data = conversation([message("assistant", text)]);
	data.title = "Long title ".repeat(20_000);
	const h = harness(async () => response(streamed(data)));
	const result = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	try {
		assert.ok(Buffer.byteLength(JSON.stringify(result)) < 5000);
		assert.ok(Buffer.byteLength(result.title) <= 1000);
		assert.ok(result.warnings.some(w => w.includes("title")));
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.ok(transcript.includes(`Title: ${data.title.trim()}\n`));
		assert.ok(transcript.includes(text));
	} finally { await cleanSaved(result); }
});

test("includes extraction warnings in metadata and in the saved reference transcript", async () => {
	const data = conversation([message("user", "Describe", { metadata: { attachments: [{ name: "report.pdf" }] } })]);
	const h = harness(async () => response(streamed(data)));
	const result = (await h.tool.execute("id", { url: URL_STRING })).structuredContent;
	try {
		assert.equal(result.warnings.length, 1);
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.match(transcript, /Imported reference material/);
		assert.ok(transcript.includes(result.warnings[0]));
		assert.match(transcript, /Attachment report.pdf: content not retrieved/);
		assert.match(transcript, /\[End of imported conversation\]\n$/);
	} finally { await cleanSaved(result); }
});

test("real codemode receives metadata and a path for a subsequent read", async () => {
	const h = harness();
	const { createCodemodeToolDefinition } = await import(pathToFileURL(join(
		__dirname, "../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/tool.js",
	)).href);
	const ctx = {
		cwd: process.cwd(), tools: [h.tool],
		sessionManager: { getBranch: () => [] },
		executeTool: async (name, params, { signal }) => {
			assert.equal(name, "read_chatgpt_share");
			const result = await h.tool.execute("codemode/1", params, signal);
			return { toolCall: { id: "codemode/1" }, result, isError: false };
		},
	};
	const result = await createCodemodeToolDefinition().execute("codemode", {
		code: `return await tools.read_chatgpt_share({ url: ${JSON.stringify(URL_STRING)} });`,
	}, undefined, undefined, ctx);
	assert.equal(result.isError, undefined);
	const output = JSON.parse(result.content.at(-1).text);
	try {
		assert.equal(output.messageCount, 2);
		assert.equal(output.messages, undefined);
		assert.equal(output.transcript, undefined);
		assert.match(await readFile(output.transcriptPath, "utf8"), /## User\n\nQuestion/);
	} finally { await cleanSaved(output); }
});

// Opt-in live test. The fetched conversation is not written into the repository.
test("live example contains the visible conversation", { skip: !process.env.CHATGPT_SHARE_LIVE }, async () => {
	const h = harness(fetch);
	const result = (await h.tool.execute("live", { url: URL_STRING })).structuredContent;
	try {
		assert.equal(result.title, "Codex miljöer");
		const transcript = await readFile(result.transcriptPath, "utf8");
		assert.match(transcript, /## User\n\nchatgpt codex environment/);
		assert.ok(transcript.includes("ChatGPT Codex Cloud environments"));
		assert.equal(result.transcript, undefined);
		console.log(`Live extraction: ${result.messageCount} visible messages, ${transcript.length} saved transcript characters.`);
	} finally { await cleanSaved(result); }
});
