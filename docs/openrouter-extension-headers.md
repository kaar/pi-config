# OpenRouter headers for Pi extensions

This reference covers app attribution and optional session headers for model requests from Pi extensions. The existing [handoff extension](../agent/extensions/handoff/index.ts) provides the example.

## App attribution

Attribution associates API usage with an app in OpenRouter rankings, model Apps tabs, and analytics. These headers do not replace OpenRouter authentication.

| Header | Requirement | Purpose |
| --- | --- | --- |
| `HTTP-Referer` | Required for app attribution | Identifies the app by its URL. OpenRouter uses this URL as the primary identifier for rankings. |
| `X-OpenRouter-Title` | Optional, except for localhost URLs | Sets or changes the app display name in rankings and analytics. `X-Title` remains a supported alias. |
| `X-OpenRouter-Categories` | Optional | Assigns the app to predefined marketplace categories. |

Without `HTTP-Referer`, OpenRouter does not create an app page or include the usage in rankings. A title or category alone does not create an app entry.

The handoff request uses:

```ts
headers: {
  "HTTP-Referer": "https://github.com/kaar/pi-config",
  "X-OpenRouter-Title": "pi-handoff",
  "X-OpenRouter-Categories": "cli-agent",
},
```

The referer, not the title, identifies the app. A different title does not establish a separate app identity for another extension with the same referer.

## Categories

Categories are predefined by OpenRouter any custom values are silently ignored.

The category header accepts a comma-separated list, such as `cli-agent,programming-app`. The limits are:

- At most **2 categories per request**.
- At most **10 categories per app**, merged across requests.
- Lowercase, hyphen-separated names, with at most 30 characters per category.

The valid coding categories are:

| Category | Use |
| --- | --- |
| `cli-agent` | Terminal-based coding assistants |
| `ide-extension` | Editor and IDE integrations |
| `cloud-agent` | Cloud-hosted coding agents |
| `programming-app` | Programming apps |
| `native-app-builder` | Mobile and desktop app builders |

## Pi request options

An extension can pass `headers` in the request options for `ctx.modelRegistry.complete()` or `ctx.modelRegistry.streamSimple()`. The model registry passes these options through the model runtime to the provider implementation in `@earendil-works/pi-ai`.

Pi defines `headers?: ProviderHeaders`. Pi AI merges caller headers with provider defaults. Caller values override default headers with the same name, so an extension can replace Pi's default app attribution.

Headers belong in the request options, not the message content or the JSON payload. The `onPayload` callback inspects or replaces the request body instead.

This excerpt follows the handoff request pattern. It assumes that the extension already has `ctx`, an OpenRouter `model`, a `prompt`, and an optional `signal`.

```ts
import { uuidv7 } from "@earendil-works/pi-ai";

const response = await ctx.modelRegistry.complete(
  model,
  {
    systemPrompt: "Write a concise continuation prompt.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    }],
  },
  {
    signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
    headers: {
      "HTTP-Referer": "https://github.com/kaar/pi-config",
      "X-OpenRouter-Title": "pi-handoff",
      "X-OpenRouter-Categories": "cli-agent",
    },
    onPayload: (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      reasoning: { enabled: false },
    }),
  },
);
```

The cache and reasoning options match handoff. Neither option is necessary for attribution. Request-local headers affect this call, not all requests in the Pi session.

If an extension can call other providers, restrict OpenRouter-specific headers to OpenRouter requests.

## Optional session grouping: `x-session-id`

OpenRouter accepts an explicit session identifier through either:

- The `x-session-id` HTTP header.
- The top-level `session_id` request-body field for Chat and Responses requests.

The body value takes precedence over the header. Both inputs have a maximum length of **256 characters**.

Pi exposes the current session identifier through `ctx.sessionManager.getSessionId()`. An extension can use this identifier as an optional header:

```ts
headers: {
  "HTTP-Referer": "https://github.com/kaar/pi-config",
  "X-OpenRouter-Title": "pi-handoff",
  "X-OpenRouter-Categories": "cli-agent",
  "x-session-id": ctx.sessionManager.getSessionId(),
},
```

This example shows optional session grouping. The handoff code does not explicitly set this header.

A stable session identifier provides two benefits:

- **Sticky routing:** OpenRouter uses the identifier instead of a hash of opening messages as the conversation key. Stickiness starts after a successful request, even before a cache hit.
- **Observability:** OpenRouter groups related requests in the [Sessions view on the Logs page](https://openrouter.ai/logs?tab=sessions). A shared identifier links turns, retries, and supported modalities.

Sticky routing operates per account, model, and conversation. It favors the same provider endpoint to improve cache reuse, but it does not guarantee cache hits. OpenRouter can use another provider if the sticky provider is unavailable. An explicit `provider.order` takes priority over sticky routing.

Sticky sessions expire after **10 minutes of inactivity**. Each successful request resets that timer. The routing timeout does not change the Pi session identifier.

A new random identifier for every request cannot group requests from the same Pi session. The current handoff request has a separate Pi option, `sessionId: uuidv7()`. This option is not the same as the explicit header example.

Pi adapters can map the `sessionId` option to provider-specific cache or affinity fields. That mapping depends on the adapter, compatibility options, and cache options. In Pi's OpenAI Completions adapter, explicit caller headers override generated affinity headers. For predictable grouping, use a stable identifier and avoid a conflicting body `session_id`.

The header also groups synchronous embeddings, reranking, audio, image, and video requests. Those endpoints accept the header for grouping only, not sticky routing. OpenRouter's Batch API does not currently group generations by session identifier.

## Optional visibility: `X-OpenRouter-App-Visibility`

The optional header `X-OpenRouter-App-Visibility: hidden` creates a new attributed app without a public listing. OpenRouter excludes the app from rankings, the marketplace, and public app pages. Attribution and private usage analytics remain available.

**The header only takes effect when OpenRouter first creates the app.** An existing app keeps its current visibility, even if a later request sends `hidden`. Existing apps include apps found through origin grouping or a prior OAuth authorization.

A missing header or any value other than `hidden` creates a public app. The header cannot change an existing app in either direction. A visibility change for an existing app requires OpenRouter support.

The handoff code does not set this header. Adding it later cannot hide an app that already exists.

## References

- [OpenRouter App Attribution](https://openrouter.ai/docs/app-attribution): attribution headers, categories, and visibility.
- [OpenRouter Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching): session identifiers, sticky routing, limits, and request grouping.
- [Pi Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) and [Custom Providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md): extension context and provider integration.
- [Pi AI request types](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) and [OpenAI Completions adapter](https://github.com/earendil-works/pi/blob/main/packages/ai/src/api/openai-completions.ts): header types, merge behavior, and session affinity.

Adapter behavior can change between Pi versions. The header merge and affinity behavior described here applies to Pi 1.0.1.
