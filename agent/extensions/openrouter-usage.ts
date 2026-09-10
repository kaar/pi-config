import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

async function request<T>(endpoint: "credits" | "key", apiKey: string): Promise<T> {
	const response = await fetch(`https://openrouter.ai/api/v1/${endpoint}`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("openrouter", {
		description: "Show OpenRouter credits and key usage",
		handler: async (_args, ctx) => {
			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) {
				ctx.ui.notify("OpenRouter usage unavailable: OPENROUTER_API_KEY is not set.", "error");
				return;
			}

			try {
				const [credits, usage] = await Promise.all([
					request<Credits>("credits", apiKey),
					request<Usage>("key", apiKey),
				]);

				const amounts = [
					credits.total_credits,
					credits.total_usage,
					usage.usage,
					usage.usage_daily,
					usage.usage_weekly,
					usage.usage_monthly,
				];
				if (!amounts.every(Number.isFinite)) {
					throw new Error("The API returned invalid credit or usage amounts.");
				}

				const lines = [
					"Credits:",
					`    Remaining: $${credits.total_credits - credits.total_usage}`,
					`    Used: $${credits.total_usage}`,
					"",
					"Usage:",
					`    Current: $${usage.usage}`,
					`    Today: $${usage.usage_daily}`,
					`    Week: $${usage.usage_weekly}`,
					`    Month: $${usage.usage_monthly}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Request failed.";
				ctx.ui.notify(`OpenRouter usage unavailable: ${message}`, "error");
			}
		},
	});
}
