import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type Credits = {
	total_credits: number;
	total_usage: number;
};

type Usage = {
	usage: number;
	usage_daily: number;
	usage_weekly: number;
	usage_monthly: number;
};

type Analytics = {
	data: Array<Record<string, unknown>>;
	metadata: { truncated: boolean };
};

type ApiKey = Usage & {
	name: string;
	disabled: boolean;
	limit: number | null;
	limit_remaining: number | null;
	limit_reset: string | null;
};

const HELP = [
	"/openrouter: account credits and current-key usage",
	"/openrouter apps [days]: spending, requests, and tokens per app",
	"/openrouter models [days]: spending, requests, and tokens per model",
	"/openrouter keys: key usage and budgets in the default workspace",
	"Days: 1-30 (default: 7). Analytics cover all account workspaces.",
].join("\n");
const DISPLAY_LIMIT = 20;
const QUERY_LIMIT = 1000;
const money = (amount: number) => `$${amount.toFixed(4)}`;

function finite(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("The API returned an invalid amount.");
	}
	return value;
}

function count(value: unknown): number {
	const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
		throw new Error("The API returned an invalid count.");
	}
	return number;
}

async function request<T>(endpoint: string, apiKey: string, query?: object): Promise<T> {
	const response = await fetch(`https://openrouter.ai/api/v1/${endpoint}`, {
		method: query ? "POST" : "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			...(query ? { "Content-Type": "application/json" } : {}),
		},
		body: query ? JSON.stringify(query) : undefined,
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(`${endpoint} request failed (HTTP ${response.status}).`);
	}

	const body = (await response.json()) as { data: T };
	if (!body?.data) {
		throw new Error(`${endpoint} returned no data.`);
	}
	return body.data;
}

async function creditsReport(apiKey: string | undefined): Promise<string> {
	if (!apiKey) throw new Error("Credits unavailable: OPENROUTER_MANAGEMENT_KEY is not set.");
	const credits = await request<Credits>("credits", apiKey);
	const total = finite(credits.total_credits);
	const used = finite(credits.total_usage);
	return ["Credits (account):", `    Remaining: ${money(total - used)}`, `    Used: ${money(used)}`].join("\n");
}

function usageLines(usage: Usage): string[] {
	return [
		`    Total: ${money(finite(usage.usage))}`,
		`    Today: ${money(finite(usage.usage_daily))}`,
		`    Week: ${money(finite(usage.usage_weekly))}`,
		`    Month: ${money(finite(usage.usage_monthly))}`,
	];
}

async function usageReport(apiKey: string | undefined): Promise<string> {
	if (!apiKey) throw new Error("Key usage unavailable: OPENROUTER_API_KEY is not set.");
	const usage = await request<Usage>("key", apiKey);
	return ["Usage (current key, UTC calendar periods):", ...usageLines(usage)].join("\n");
}

async function analyticsReport(dimension: "app" | "model", days: number, apiKey: string): Promise<string> {
	const end = new Date();
	const start = new Date(end.getTime() - days * 86_400_000);
	const result = await request<Analytics>("analytics/query", apiKey, {
		metrics: ["total_usage", "request_count", "tokens_total"],
		dimensions: [dimension],
		time_range: { start: start.toISOString(), end: end.toISOString() },
		order_by: { field: "total_usage", direction: "desc" },
		limit: QUERY_LIMIT,
	});
	if (!Array.isArray(result.data) || typeof result.metadata?.truncated !== "boolean") {
		throw new Error("The API returned invalid analytics data.");
	}
	const rows = result.data.map((row) => {
		if (!row || (row[dimension] != null && typeof row[dimension] !== "string")) {
			throw new Error("The API returned an invalid analytics label.");
		}
		return {
			label: row[dimension] || "Unknown",
			usage: finite(row.total_usage),
			requests: count(row.request_count),
			tokens: count(row.tokens_total),
		};
	}).sort((a, b) => b.usage - a.usage);
	const cells = rows.slice(0, DISPLAY_LIMIT).map((row) => [
		`${row.label}: ${money(row.usage)}`,
		`${row.requests.toLocaleString("en-US")} requests`,
		`${row.tokens.toLocaleString("en-US")} tokens`,
	]);
	const widths = [0, 1].map((column) => Math.max(0, ...cells.map((row) => visibleWidth(row[column]))));
	const lines = [
		`${dimension === "app" ? "Apps" : "Models"} (account, last ${days} days):`,
		...cells.map((row) => `    ${row.map((cell, column) => column < widths.length
			? cell + " ".repeat(widths[column] - visibleWidth(cell)) : cell).join(" | ")}`),
	];
	if (!rows.length) lines.push("    No usage in this period.");
	if (rows.length > DISPLAY_LIMIT) lines.push(`    Showing the top ${DISPLAY_LIMIT} of ${rows.length} returned groups.`);
	if (result.metadata.truncated) lines.push("    The API truncated the results. Only the highest-spending groups are shown.");
	return lines.join("\n");
}

async function keysReport(apiKey: string): Promise<string> {
	const keys: ApiKey[] = [];
	// The keys endpoint uses offset pagination and defaults to the default workspace.
	for (let page = 0; ; page++) {
		if (page >= 100) throw new Error("The API returned too many key pages.");
		const batch = await request<ApiKey[]>(`keys?include_disabled=true&offset=${keys.length}`, apiKey);
		if (!Array.isArray(batch)) throw new Error("The API returned invalid key data.");
		if (!batch.length) break;
		keys.push(...batch);
	}
	const rows = keys.map((key) => {
		if (!key || typeof key.name !== "string" || typeof key.disabled !== "boolean"
			|| (key.limit_reset !== null && typeof key.limit_reset !== "string")) {
			throw new Error("The API returned invalid key data.");
		}
		const usage = usageLines(key);
		const limit = key.limit === null ? null : finite(key.limit);
		const remaining = key.limit_remaining === null ? null : finite(key.limit_remaining);
		if (limit !== null && remaining === null) throw new Error("The API returned an invalid key budget.");
		return { key, usage, limit, remaining };
	}).sort((a, b) => b.key.usage - a.key.usage);
	const lines = ["Keys (default workspace, UTC calendar periods):"];
	for (const { key, usage, limit, remaining } of rows.slice(0, DISPLAY_LIMIT)) {
		lines.push(`    ${key.name || "Unnamed key"}${key.disabled ? " (disabled)" : ""}`, ...usage,
			limit === null ? "    Budget: unlimited" :
				`    Budget: ${money(remaining!)} remaining of ${money(limit)} (${key.limit_reset || "lifetime"})`, "");
	}
	if (!rows.length) lines.push("    No keys in the default workspace.");
	if (rows.length > DISPLAY_LIMIT) lines.push(`    Showing the top ${DISPLAY_LIMIT} of ${rows.length} keys by total usage.`);
	return lines.join("\n").trimEnd();
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("openrouter", {
		description: "Show OpenRouter credits, app/model spending, and key budgets",
		getArgumentCompletions: (prefix) => ["apps", "models", "keys", "help"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command, dayArg, ...extra] = args.trim().split(/\s+/);
			if (command === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			const analytics = command === "apps" || command === "models";
			const days = dayArg === undefined ? 7 : Number(dayArg);
			if (extra.length || (!analytics && dayArg !== undefined)
				|| (command && !analytics && command !== "keys")
				|| (analytics && (dayArg !== undefined && !/^\d+$/.test(dayArg)
					|| !Number.isInteger(days) || days < 1 || days > 30))) {
				ctx.ui.notify(HELP, "error");
				return;
			}
			const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
			try {
				if (!command) {
					// A failed or missing credential must not hide the other report.
					const results = await Promise.allSettled([
						creditsReport(managementKey), usageReport(process.env.OPENROUTER_API_KEY),
					]);
					const reports = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
					const errors = results.filter((r) => r.status === "rejected")
						.map((r) => r.reason instanceof Error ? r.reason.message : "Request failed.");
					ctx.ui.notify([...reports, ...errors].join("\n\n"), errors.length ? (reports.length ? "warning" : "error") : "info");
					return;
				}
				if (!managementKey) throw new Error("OPENROUTER_MANAGEMENT_KEY is not set.");
				const report = command === "keys" ? await keysReport(managementKey)
					: await analyticsReport(command === "apps" ? "app" : "model", days, managementKey);
				ctx.ui.notify(report, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Request failed.";
				ctx.ui.notify(`OpenRouter usage unavailable: ${message}`, "error");
			}
		},
	});
}
