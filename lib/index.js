/**
 * `dsh-web-search-tavily` — a `ctx.web` search provider backed by Tavily.
 *
 * Talks to `POST {baseURL}/search` with `Authorization: Bearer <tvly-key>` as documented at
 * https://docs.tavily.com/documentation/api-reference/endpoint/search. Each call is one plain
 * HTTP request, so unlike the 百炼-backed provider there is no model turn behind it and no
 * shared token-plan budget to protect; the throttle exists only to keep DSH's fan-out of up to
 * four concurrent queries inside Tavily's per-plan rate limit.
 *
 * Response mapping: `results[]` becomes normalized `sources[]` (`url`, `title`, `content` ->
 * `snippet`, `published_date` -> `publishedAt`) and `answer` becomes the optional
 * provider-generated `content`. `score` and `raw_content` are dropped — the seam has no place
 * for a relevance number, and raw page bodies would blow the model context.
 *
 * Credential resolution order: literal `apiKey` from config, then the credential named by
 * `apiKeyEnv` (default `TAVILY_API_KEY`) via the `credentials` service, then the same name in
 * the launch environment. The key itself lives in `~/.dsh/.credentials.yaml` or an env var, not
 * in the plaintext patch file.
 *
 * @module dsh-web-search-tavily
 */
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";

/** Primary registry id for this backend. */
export const PROVIDER_ID = "tavily";
/** Alias id for configs that prefer to name the plugin rather than the vendor. */
export const PROVIDER_ID_ALIAS = "dsh-web-search-tavily";/** Default credential / environment variable holding the Tavily API key. */
export const DEFAULT_API_KEY_ENV = "TAVILY_API_KEY";
/** Environment variable overriding the endpoint when config leaves `baseURL` empty. */
export const SEARCH_BASE_URL_ENV = "TAVILY_BASE_URL";
/** Tavily production root; `/search` is the operation. */
export const DEFAULT_BASE_URL = "https://api.tavily.com";
/** Settings namespace carrying this provider's resolved configuration. */
export const SETTINGS_NAMESPACE = "web-search-tavily";
/** Hard cap on sources surfaced by one search, independent of the seam's maxResults. */
export const MAX_SOURCES = 20;
/** Tavily documents `max_results` as [0, 20]; clamp before sending so a bad config cannot 422. */
const MAX_REQUEST_RESULTS = 20;
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = "dsh-web-search-tavily/1.0.0";
/** Cool-down applied when a 429 carries no usable Retry-After value. */
const DEFAULT_RETRY_AFTER_MS = 5_000;

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function retryAfterMs(header) {
	if (typeof header !== "string" || header.length === 0) return void 0;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.floor(seconds * 1e3), 6e4);
	const date = Date.parse(header);
	return Number.isFinite(date) ? Math.min(Math.max(0, date - Date.now()), 6e4) : void 0;
}

/** Compact one-line summary of a provider error body. */
function summarize(text, status) {
	const trimmed = String(text ?? "").replace(/\s+/gu, " ").trim();
	if (trimmed.length === 0) return `HTTP ${status}`;
	return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/** Pull the human-readable message out of Tavily's `{detail:{error}}` / `{detail:[]}` bodies. */
function extractDetail(bodyText) {
	let parsed;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return void 0;
	}
	const detail = parsed?.detail;
	if (typeof detail === "string" && detail.length > 0) return detail;
	if (typeof detail?.error === "string" && detail.error.length > 0) return detail.error;
	if (Array.isArray(detail) && detail.length > 0) {
		const parts = detail.map((entry) => [Array.isArray(entry?.loc) ? entry.loc.join(".") : "", typeof entry?.msg === "string" ? entry.msg : ""].filter((piece) => piece.length > 0).join(": ")).filter((piece) => piece.length > 0);
		if (parts.length > 0) return parts.join("; ");
	}
	return void 0;
}

/**
 * Build the error thrown for one failed Tavily response, carrying the fields the retry loop
 * needs (`status`, `rateLimited`, `retry`, `retryAfterMs`).
 *
 * 401/403/432/433 are never retried: a wrong key, a blocked key or an exhausted plan does not
 * heal between attempts. 429 is retried with the server's own delay when it sends one.
 *
 * @param status - HTTP status code.
 * @param bodyText - raw response body.
 * @param retryAfter - value of the `Retry-After` response header, if any.
 */
export function tavilyError(status, bodyText, retryAfter) {
	const text = String(bodyText ?? "");
	const detail = extractDetail(text);
	const rateLimited = status === 429;
	const retry = rateLimited || status >= 500 && status <= 599;
	const error = new Error(`Tavily search failed: ${detail ?? summarize(text, status)}`);
	error.status = status;
	error.rateLimited = rateLimited;
	error.retry = retry;
	error.retryAfterMs = rateLimited ? retryAfterMs(retryAfter) : void 0;
	return error;
}

/** True for a fetch/AbortSignal cancellation. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}

/** Throw the provider's stable cancellation error when the caller already aborted. */
function throwIfAborted(signal) {
	if (signal?.aborted === true) throw searchAborted(signal);
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function searchAborted(signal, fallback) {
	return new WebError("Tavily search aborted", "WEB_ABORTED", { cause: signal?.aborted === true ? signal.reason : fallback });
}

/** Race a same-process asynchronous preflight against caller cancellation. */
function abortable(operation, signal) {
	if (signal === void 0) return operation;
	if (signal.aborted) return Promise.reject(searchAborted(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(searchAborted(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then((value) => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		}, (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(String(error).replace(/^Error: /u, ""), { cause: error }));
		});
	});
}

/** Resolve after `ms`; reject with `AbortError` if `signal` aborts first. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/** Positive integer with a fallback, so a bad config value can never wedge the gate. */
function positiveInt(value, fallback) {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/** Non-negative integer with a fallback, where 0 is a legitimate value. */
function nonNegativeInt(value, fallback) {
	if (value === void 0 || value === null) return fallback;
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

/** Trim and de-duplicate a domain list, accepting an array or one comma-separated string. */
function cleanDomains(list, limit) {
	const entries = Array.isArray(list) ? list : splitList(list);
	if (entries.length === 0) return [];
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const domain = entry.trim().toLowerCase();
		if (domain.length === 0 || seen.has(domain)) continue;
		seen.add(domain);
		out.push(domain);
		if (out.length >= limit) break;
	}
	return out;
}

/** Split a single-line comma-separated domain list into an array. */
function splitList(value) {
	if (typeof value !== "string" || value.trim().length === 0) return [];
	return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
/** Per-bucket mutable state for the process-global limiter. */
var Bucket = class {
	constructor() {
		this.active = 0;
		this.lastStartAt = 0;
		this.cooldownUntil = 0;
		this.waiters = [];
		this.admitted = 0;
	}
};

/**
 * Limiter state lives process-global under a fixed symbol. Cordis can reload a plugin fiber
 * without re-evaluating an already-imported ES module, so a limiter held inside `apply()` would
 * reset to wide open on every hot reload, and module-local state would not be shared across the
 * two aliases this plugin registers.
 */
const BUCKETS_KEY = Symbol.for("dsh.throttle.buckets.v1");
/** @type {Map<string, Bucket>} */
const buckets = globalThis[BUCKETS_KEY] ??= /* @__PURE__ */ new Map();

/** Fetch (creating it if needed) the bucket for `id`. */
function bucketFor(id) {
	let bucket = buckets.get(id);
	if (bucket === void 0) {
		bucket = new Bucket();
		buckets.set(id, bucket);
	}
	return bucket;
}

/** Snapshot of one bucket's live counters, for diagnostics. */
export function throttleStats(id) {
	const bucket = bucketFor(id);
	return { id, active: bucket.active, admitted: bucket.admitted, waiting: bucket.waiters.length, cooldownRemainingMs: Math.max(0, bucket.cooldownUntil - Date.now()) };
}

/** Park until some holder releases a slot in this bucket. */
function waitForSlot(bucket, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new DOMException("aborted", "AbortError"));
			return;
		}
		const waiter = { resolve, reject };
		const onAbort = () => {
			const index = bucket.waiters.indexOf(waiter);
			if (index >= 0) bucket.waiters.splice(index, 1);
			reject(new DOMException("aborted", "AbortError"));
		};
		waiter.cleanup = () => signal?.removeEventListener?.("abort", onAbort);
		bucket.waiters.push(waiter);
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/** Hand the freed slot to the first parked waiter, if any. */
function drain(bucket) {
	const waiter = bucket.waiters.shift();
	if (waiter === void 0) return;
	waiter.cleanup?.();
	waiter.resolve();
}

/** Wait for a slot, then honour the spacing rule. */
async function admit(bucket, { maxConcurrent, minGapMs, signal }) {
	bucket.pending = (bucket.pending ?? 0) + 1;
	try {
		while (true) {
			throwIfAborted(signal);
			const now = Date.now();
			const cooldownWait = bucket.cooldownUntil - now;
			if (cooldownWait > 0) {
				await sleep(cooldownWait, signal);
				continue;
			}
			if (bucket.active >= maxConcurrent) {
				await waitForSlot(bucket, signal);
				continue;
			}
			const gapWait = bucket.lastStartAt + minGapMs - now;
			if (gapWait > 0) {
				await sleep(gapWait, signal);
				continue;
			}
			bucket.active += 1;
			bucket.lastStartAt = Date.now();
			bucket.admitted += 1;
			return;
		}
	} finally {
		bucket.pending -= 1;
	}
}

/** Release the slot reserved by `admit` and wake the next waiter. */
function release(bucket) {
	bucket.active = Math.max(0, bucket.active - 1);
	drain(bucket);
}

/**
 * Run `operation` under the bucket's concurrency / spacing / cool-down gate, retrying only what
 * `isRetryable` deems worth replaying. A rate-limited failure opens the circuit for
 * `cooldownMs` (or the server's `Retry-After` when larger) before the next attempt.
 *
 * @param id - bucket id; different plans or capabilities should use distinct ids.
 * @param options - `{ maxConcurrent, minGapMs, cooldownMs, maxRetries, signal, isRetryable }`.
 * @param operation - receives the zero-based attempt index.
 * @returns whatever `operation` resolves to.
 */
async function throttled(id, options, operation) {
	const bucket = bucketFor(id);
	const maxConcurrent = positiveInt(options.maxConcurrent, 2);
	const minGapMs = nonNegativeInt(options.minGapMs, 150);
	const cooldownMs = positiveInt(options.cooldownMs, 5_000);
	const maxRetries = nonNegativeInt(options.maxRetries, 2);
	const signal = options.signal;
	for (let attempt = 0; ; attempt += 1) {
		await admit(bucket, { maxConcurrent, minGapMs, signal });
		try {
			return await operation(attempt);
		} catch (error) {
			if (options.isRetryable?.(error) !== true || attempt >= maxRetries) throw error;
			if (error?.rateLimited === true) {
				const wait = Math.max(cooldownMs, positiveInt(error.retryAfterMs, 0));
				bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + wait);
			}
			await sleep(1e3 * 2 ** attempt + Math.floor(Math.random() * 250), signal);
		} finally {
			release(bucket);
		}
	}
}

/**
 * Normalize one Tavily `results[]` entry into a seam source.
 * @param entry - one result record.
 * @returns the source, or `void 0` when the record carries no usable URL.
 */
export function mapTavilyResult(entry) {
	const url = typeof entry?.url === "string" ? entry.url.trim() : "";
	if (url.length === 0) return void 0;
	return {
		url,
		...typeof entry.title === "string" && entry.title.length > 0 ? { title: entry.title } : {},
		...typeof entry.content === "string" && entry.content.length > 0 ? { snippet: entry.content } : {},
		...typeof entry.published_date === "string" && entry.published_date.length > 0 ? { publishedAt: entry.published_date } : {},
	};
}

/**
 * Map a Tavily search response to the seam's normalized result.
 *
 * @param payload - the parsed `/search` body.
 * @returns `{ content?, sources, truncated: false }`; blank fields are omitted.
 */
export function mapTavilyResponse(payload) {
	const results = Array.isArray(payload?.results) ? payload.results : [];
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const entry of results) {
		const source = mapTavilyResult(entry);
		if (source === void 0 || seen.has(source.url) || sources.length >= MAX_SOURCES) continue;
		seen.add(source.url);
		sources.push(source);
	}
	const answer = typeof payload?.answer === "string" ? payload.answer.trim() : "";
	return { ...answer.length > 0 ? { content: answer } : {}, sources, truncated: false };
}

/**
 * Build the JSON request body for one query. Only configured values are sent so Tavily's own
 * defaults stay in charge of everything else; `include_answer` must be truthy for the seam to
 * ever carry provider text, hence the default `"basic"` in `Config`.
 *
 * @param options - resolved provider options.
 * @param query - the search query.
 * @param maxResults - the seam's bound, clamped to Tavily's documented range.
 * @returns the request body.
 */
export function buildSearchBody(options, query, maxResults) {
	const includeDomains = cleanDomains(options.includeDomains, 300);
	const excludeDomains = cleanDomains(options.excludeDomains, 150);
	const requested = positiveInt(maxResults, options.maxResults);
	if (requested <= 0) throw new WebError(`maxResults ${maxResults} is not usable: Tavily needs at least one result`, "WEB_PROVIDER_ERROR");
	const body = { query, topic: options.topic, search_depth: options.searchDepth, max_results: Math.min(requested, MAX_REQUEST_RESULTS), include_answer: options.includeAnswer, include_image_descriptions: false, include_favicon: false, include_usage: false };
	if (options.timeRange.length > 0) body.time_range = options.timeRange;
	if (options.country.length > 0) body.country = options.country;
	if (includeDomains.length > 0) body.include_domains = includeDomains;
	if (excludeDomains.length > 0) body.exclude_domains = excludeDomains;
	return body;
}

/** In-flight searches keyed by query+depth+topic, so concurrent duplicates share one request. */
const inFlight = /* @__PURE__ */ new Map();

/** The Tavily-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export var TavilySearchProvider = class {
	resolveOptions;
	id;
	/**
	 * @param resolveOptions - options for the NEXT operation, snapshotted once per entry so one
	 *   search never mixes two config sections.
	 * @param id - the registry id this instance answers to.
	 */
	constructor(resolveOptions, id = PROVIDER_ID) {
		this.resolveOptions = resolveOptions;
		this.id = id;
	}
	available() {
		const options = this.resolveOptions();
		return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== void 0) && URL.canParse(options.baseURL);
	}
	async search(request, signal) {
		const options = this.resolveOptions();
		const apiKey = await this.apiKey(options, signal);
		throwIfAborted(signal);
		// DSH's web_search tool fans a multi-query call out concurrently (up to 4 queries).
		// Identical queries arriving together share one paid request.
		const key = `${options.searchDepth}\u0000${options.topic}\u0000${request.query}`;
		const existing = inFlight.get(key);
		if (existing !== void 0) return await existing;
		const operation = this.runSearch(options, apiKey, request, signal);
		inFlight.set(key, operation);
		try {
			return await operation;
		} finally {
			if (inFlight.get(key) === operation) inFlight.delete(key);
		}
	}
	/** Run one search against Tavily, mapping failures into seam errors. */
	async runSearch(options, apiKey, request, signal) {
		let payload;
		try {
			payload = await this.request(options, apiKey, request, signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			if (error instanceof WebError) throw error;
			throw new WebError(String(error?.message ?? error), "WEB_PROVIDER_ERROR", { cause: error });
		}
		const mapped = mapTavilyResponse(payload);
		if (mapped.sources.length === 0) {
			// An HTTP 200 with no citations is a provider failure, not an empty result: silently
			// returning [] would make the model believe nothing exists on the web for the query.
			throw new WebError(`Tavily returned no results for "${request.query}"${mapped.content === void 0 ? "" : `; answer: ${mapped.content.slice(0, 200)}`}`, "WEB_PROVIDER_ERROR");
		}
		// The seam enforces `request.maxResults` on the way back, so returning every source here
		// is safe and lets one request serve several coalesced queries.
		return mapped;
	}
	/** One throttled `POST {baseURL}/search`. */
	async request(options, apiKey, request, signal) {
		const base = options.baseURL.replace(/\/+$/u, "");
		return await throttled(options.bucket, {
			maxConcurrent: options.maxConcurrentRequests,
			minGapMs: options.minRequestGapMs,
			cooldownMs: options.cooldownMs,
			maxRetries: options.maxRetries,
			...signal === void 0 ? {} : { signal },
			isRetryable: (error) => error?.retry === true,
		}, async () => {
			let response;
			try {
				response = await fetch(`${base}/search`, {
					method: "POST",
					redirect: "error",
					headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT },
					body: JSON.stringify(buildSearchBody(options, request.query, request.maxResults)),
					...signal === void 0 ? {} : { signal },
				});
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
				// undici reports a refused redirect (`redirect: "error"`) as a bare TypeError from
				// fetch, so it lands here with the rest of the transport failures. Never retried:
				// Tavily's documented endpoint does not redirect, so a redirect means this host is
				// intercepting the request and replaying the key elsewhere would be worse.
				throw new WebError(`Tavily search request failed: ${String(error?.message ?? error)}${error?.cause?.code === undefined ? "" : ` (${error.cause.code})`}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
			const text = await response.text();
			if (!response.ok) throw tavilyError(response.status, text, response.headers.get("retry-after"));
			try {
				return JSON.parse(text);
			} catch (error) {
				if (isAbortError(error)) throw searchAborted(signal, error);
				throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
			}
		});
	}
	/**
	 * Resolve one operation's credential without retaining it on the provider.
	 * Prefers the literal config value, then the named credential, then the launch environment.
	 */
	async apiKey(options, signal) {
		throwIfAborted(signal);
		if (options.apiKey !== void 0 && options.apiKey.length > 0) return options.apiKey;
		let resolved;
		try {
			resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(void 0), signal);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw searchAborted(signal, error);
			throw new WebError(`Tavily search credential resolution failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
		}
		if (typeof resolved === "string" ? resolved.length > 0 : (resolved?.value?.length ?? 0) > 0) return typeof resolved === "string" ? resolved : resolved.value;
		const wanted = options.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
		throw new WebError(`Tavily search has no API key configured for "${wanted}". Add it to ~/.dsh/.credentials.yaml as "${wanted}: tvly-..." (get a key at https://app.tavily.com), or point the "${SETTINGS_NAMESPACE}" config's apiKeyEnv at whichever credential holds it.`, "WEB_PROVIDER_CREDENTIAL_MISSING");
	}
};

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-tavily";
/** Services required by this plugin. */
export const inject = ["web"];

const Config = z.object({
	apiKey: z.string().role("secret").volatile(),
	apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV).volatile(),
	baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
	topic: z.union(["general", "news", "finance"]).default("general").volatile(),
	searchDepth: z.union(["basic", "advanced", "fast", "ultra-fast"]).default("basic").volatile(),
	includeAnswer: z.union([z.boolean(), "basic", "advanced"]).default("basic").volatile(),
	maxResults: z.number().step(1).min(1).default(10).volatile(),
	timeRange: z.string().default("").volatile(),
	country: z.string().default("").volatile(),
	includeDomains: z.string().default("").volatile(),
	excludeDomains: z.string().default("").volatile(),
	maxConcurrentRequests: z.number().step(1).min(1).default(2).volatile(),
	minRequestGapMs: z.number().step(1).min(0).default(150).volatile(),
	cooldownMs: z.number().step(1).min(1e3).default(5e3).volatile(),
	maxRetries: z.number().step(1).min(0).default(2).volatile(),
});

/** Values Tavily accepts for `time_range`; anything else is dropped rather than 422'd. */
const TIME_RANGES = new Set(["day", "week", "month", "year"]);

/**
 * Project one resolved config section into the options the provider serves its next search with.
 * Environment fallbacks stay here rather than in the provider: every value it reads is already
 * fully defaulted.
 *
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
export function resolveOptions(ctx, config) {
	const apiKeyEnv = credentialRef(config.apiKeyEnv?.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV);
	const literalApiKey = config.apiKey !== void 0 && config.apiKey.length > 0 ? config.apiKey : void 0;
	const configuredRange = typeof config.timeRange === "string" ? config.timeRange.trim().toLowerCase() : "";
	return {
		...literalApiKey === void 0 ? {} : { apiKey: literalApiKey },
		resolveApiKey: async () => {
			const wanted = config.apiKeyEnv?.length > 0 ? config.apiKeyEnv : DEFAULT_API_KEY_ENV;
			const credentials = ctx.get("credentials");
			if (credentials !== void 0) {
				try {
					const resolved = await credentials.resolve(wanted);
					// Accept both the documented `{ value, source }` shape and a bare string.
					const value = typeof resolved === "string" ? resolved : resolved?.value;
					if (value) return typeof resolved === "string" ? { value: resolved } : resolved;
				} catch {
					// A missing ref falls through to the launch environment below.
				}
			}
			const ambient = launchEnvironmentOf(ctx).get(wanted);
			return ambient === void 0 || ambient.value.length === 0 ? void 0 : { value: ambient.value };
		},
		apiKeyEnv,
		baseURL: config.baseURL && config.baseURL.length > 0 ? config.baseURL : launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value ?? DEFAULT_BASE_URL,
		topic: config.topic || "general",
		searchDepth: config.searchDepth || "basic",
		includeAnswer: config.includeAnswer === void 0 ? "basic" : config.includeAnswer,
		maxResults: positiveInt(config.maxResults, 10),
		timeRange: TIME_RANGES.has(configuredRange) ? configuredRange : "",
		country: typeof config.country === "string" ? config.country.trim() : "",
		includeDomains: cleanDomains(config.includeDomains, 300),
		excludeDomains: cleanDomains(config.excludeDomains, 150),
		bucket: `tavily:${apiKeyEnv}`,
		maxConcurrentRequests: positiveInt(config.maxConcurrentRequests, 2),
		minRequestGapMs: nonNegativeInt(config.minRequestGapMs, 150),
		cooldownMs: positiveInt(config.cooldownMs, 5e3),
		maxRetries: nonNegativeInt(config.maxRetries, 2),
	};
}

/** Read one Config field, tolerating both the 0.2.x reactive accessor (`{ get(): T }`) and the
* pre-0.2 plain value. The reactive host (cordis 4 + dsh-settings 0.2) hands each schema field
* as an accessor; older hosts handed a plain object. Accepting both keeps the plugin
* host-agnostic so the same package loads on either side without a shim. */
function getField(config, key) {
	const value = config?.[key];
	return typeof value === "object" && value !== null && typeof value.get === "function" ? value.get() : value;
}

/** Register the Tavily search providers under their primary and alias ids. */
export function apply(ctx, config) {
	// 0.2.x: SettingsForms derives the page from this entry's `Config` schema automatically; the
	// plugin no longer installs the section itself. The host passes each schema field as a
	// reactive accessor, so we snapshot once per call to hand `resolveOptions` plain values.
	const snapshot = () => ({
		apiKey: getField(config, "apiKey"),
		apiKeyEnv: getField(config, "apiKeyEnv"),
		baseURL: getField(config, "baseURL"),
		topic: getField(config, "topic"),
		searchDepth: getField(config, "searchDepth"),
		includeAnswer: getField(config, "includeAnswer"),
		maxResults: getField(config, "maxResults"),
		timeRange: getField(config, "timeRange"),
		country: getField(config, "country"),
		includeDomains: getField(config, "includeDomains"),
		excludeDomains: getField(config, "excludeDomains"),
		maxConcurrentRequests: getField(config, "maxConcurrentRequests"),
		minRequestGapMs: getField(config, "minRequestGapMs"),
		cooldownMs: getField(config, "cooldownMs"),
		maxRetries: getField(config, "maxRetries"),
	});
	const providerFor = (id) => new TavilySearchProvider(() => resolveOptions(ctx, snapshot()), id);
	ctx.web.registerSearchProvider(providerFor(PROVIDER_ID));
	ctx.web.registerSearchProvider(providerFor(PROVIDER_ID_ALIAS));
}

export { Config, MAX_REQUEST_RESULTS };
