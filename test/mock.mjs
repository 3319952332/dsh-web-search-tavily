#!/usr/bin/env node
/**
 * Offline regression tests for `dsh-web-search-tavily`.
 *
 * The plugin is loaded with its `@deepseek-ai/*` peer imports rewritten to local stubs (except
 * schemastery, which loads from the real installed package so a schema mistake cannot pass), then
 * exercised against an in-process mock Tavily server. Nothing here touches api.tavily.com, so the
 * suite costs no credits and can run before publishing.
 *
 * Usage: `node web-search-tavily/test/mock.mjs`
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = await mkdtemp(path.join(os.tmpdir(), "dsh-tavily-tests-"));

/** Profile node_modules to resolve real peer deps from (override with env). */
const profileModules = process.env.DSH_PROFILE_MODULES ?? path.join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "profiles", "node_modules");

let passed = 0;
let failed = 0;
async function test(label, body) {
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${label}`);
	} catch (error) {
		failed += 1;
		console.error(`  FAIL ${label}\n       ${error?.stack ?? error}`);
	}
}

/** Locate an installed package's ESM entry so stubs can import the real thing. */
async function resolvePackageEntry(name) {
	const roots = [profileModules, path.join(root, "deepseek-harness", "node_modules"), ...launcherVersionDirs()].filter(Boolean);
	for (const base of roots) {
		try {
			const req = createRequire(path.join(base, "noop.js"));
			return pathToFileURL(req.resolve(name)).href;
		} catch {
			// try the next root
		}
	}
	throw new Error(`cannot resolve ${name}; run the suite against an installed DSH profile`);
}

/** Every `dsh-launcher/versions/<v>/node_modules` on this machine, newest first. */
function launcherVersionDirs() {
	const versions = path.join(process.env.LOCALAPPDATA || "", "dsh-launcher", "versions");
	if (!versions || !existsSync(versions)) return [];
	return readdirSync(versions, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(versions, entry.name, "node_modules")).reverse();
}

/**
 * Rewrite peer-dep imports so the module loads standalone. `@deepseek-ai/schemastery` resolves to
 * the real package on purpose: a hand-written `z` proxy silently accepts calls that do not exist.
 */
async function loadStubbed(source) {
	const schemastery = await resolvePackageEntry("@deepseek-ai/schemastery");
	const prelude = `import z from "${schemastery}";\nconst credentialRef = (x) => x;\nconst launchEnvironmentOf = () => ({ get: () => undefined });\nclass WebError extends Error { constructor(message, code, options) { super(message); this.code = code; Object.assign(this, options ?? {}); } }\n`;
	const original = await readFile(source, "utf8");
	const rewritten = original.replace(/import\s+\{[^}]*\}\s+from\s+"@deepseek-ai\/(?!schemastery)[^"]*";?\n/gu, "").replace(/^import z from "@deepseek-ai\/schemastery";?\n/gmu, "");
	const target = path.join(work, `${path.basename(path.dirname(source))}-${Date.now()}.mjs`);
	await writeFile(target, prelude + rewritten, "utf8");
	return await import(pathToFileURL(target).href);
}

const plugin = await loadStubbed(path.join(root, "web-search-tavily/lib/index.js"));

/* ------------------------------------------------------------------ mock server */

/** @type {{ count: number, requests: any[], bodies: string[], delayMs: number, respond: (index: number) => { status: number, body: string } }} */
const server = { count: 0, requests: [], bodies: [], delayMs: 0, script: [], retryAfter: void 0 };
/** Path a `/search` request answers with 302 to, set only by the redirect test. */
let redirectsTo;
const httpServer = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", async () => {
		server.count += 1;
		server.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, userAgent: req.headers["user-agent"], contentType: req.headers["content-type"] });
		server.bodies.push(raw);
		if (server.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, server.delayMs));
		if (redirectsTo !== void 0 && req.url === "/search") {
			res.writeHead(302, { location: redirectsTo });
			res.end();
			return;
		}
		const step = server.script.shift();
		if (step === void 0) {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ detail: { error: "mock has no scripted response left" } }));
			return;
		}
		const headers = { "content-type": "application/json", ...(step.headers ?? {}) };
		if (step.retryAfter !== void 0) headers["retry-after"] = String(step.retryAfter);
		res.writeHead(step.status, headers);
		res.end(step.body);
	});
});
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${httpServer.address().port}`;

const okBody = JSON.stringify({
	query: "who is Leo Messi?",
	answer: "  An Argentine footballer.  ",
	results: [
		{ title: "Lionel Messi | Britannica", url: "https://www.britannica.com/facts/Lionel-Messi", content: "Born in 1987.", score: 0.93, published_date: "Tue, 11 Mar 2025 17:00:00 GMT", raw_content: "<html>huge</html>" },
		{ title: "Messi - Wikipedia", url: "https://en.wikipedia.org/wiki/Lionel_Messi", content: "Plays for Inter Miami.", score: 0.88 },
		{ title: "", url: "https://dup.example/x", content: "" },
		{ title: "Dup", url: "https://dup.example/x", content: "second copy" },
		{ title: "No url", content: "dropped" },
	],
	images: [],
	response_time: 0.4,
});

function scriptOk(count = 1) {
	for (let index = 0; index < count; index += 1) server.script.push({ status: 200, body: okBody });
}

/** Minimal plugin context: web seam capture plus an optional credentials service. */
function makeContext(credentialValue) {
	const providers = [];
	const ctx = {
		web: { registerSearchProvider: (provider) => providers.push(provider) },
		inject: (deps, fn) => {
			fn(ctx);
		},
		get: (service) => (service === "credentials" && credentialValue !== void 0 ? { resolve: async () => ({ value: credentialValue, source: "test" }) } : void 0),
		settings: { installSection: (_ctx, _ns, _schema, config) => ({ get: () => config }) },
	};
	return { ctx, providers };
}

const baseConfig = { apiKeyEnv: "TAVILY_API_KEY", baseURL, topic: "general", searchDepth: "basic", includeAnswer: "basic", maxResults: 10, timeRange: "", country: "", includeDomains: "", excludeDomains: "", maxConcurrentRequests: 2, minRequestGapMs: 0, cooldownMs: 1e3, maxRetries: 2 };

console.log("dsh-web-search-tavily offline regression");

/* ------------------------------------------------------------------ pure mapping */

await test("mapTavilyResponse normalizes sources and drops blank/duplicate URLs", () => {
	const mapped = plugin.mapTavilyResponse(JSON.parse(okBody));
	assert.equal(mapped.content, "An Argentine footballer.", "answer trimmed into content");
	assert.deepEqual(mapped.sources.map((source) => source.url), ["https://www.britannica.com/facts/Lionel-Messi", "https://en.wikipedia.org/wiki/Lionel_Messi", "https://dup.example/x"]);
	assert.equal(mapped.sources[0].snippet, "Born in 1987.");
	assert.equal(mapped.sources[0].publishedAt, "Tue, 11 Mar 2025 17:00:00 GMT");
	assert.equal("score" in mapped.sources[0], false, "relevance score is not part of the seam");
	assert.equal(mapped.sources[1].title, "Messi - Wikipedia");
	assert.equal(mapped.truncated, false);
});

await test("mapTavilyResponse omits content when answer is absent or blank", () => {
	assert.equal(plugin.mapTavilyResponse({ results: [{ url: "https://a.example" }], answer: "   " }).content, void 0);
	const bare = plugin.mapTavilyResponse({ results: [{ url: "https://a.example" }] });
	assert.equal(bare.content, void 0);
	assert.deepEqual(bare.sources, [{ url: "https://a.example" }]);
});

await test("mapTavilyResponse survives a malformed payload", () => {
	assert.deepEqual(plugin.mapTavilyResponse(void 0), { sources: [], truncated: false });
	assert.deepEqual(plugin.mapTavilyResponse({ results: "nope" }), { sources: [], truncated: false });
});

await test("buildSearchBody sends only documented fields and clamps max_results", () => {
	const body = plugin.buildSearchBody({ ...baseConfig, topic: "news", searchDepth: "advanced", includeAnswer: true, timeRange: "week", country: "china", includeDomains: ["a.com", "A.COM ", "", "b.com"], excludeDomains: "spam.io" }, "q", 99);
	assert.equal(body.query, "q");
	assert.equal(body.topic, "news");
	assert.equal(body.search_depth, "advanced");
	assert.equal(body.max_results, plugin.MAX_REQUEST_RESULTS, "clamped to Tavily's documented maximum");
	assert.equal(body.include_answer, true);
	assert.equal(body.time_range, "week");
	assert.equal(body.country, "china");
	assert.deepEqual(body.include_domains, ["a.com", "b.com"], "trimmed, lowercased, de-duplicated");
	assert.deepEqual(body.exclude_domains, ["spam.io"]);
	const minimal = plugin.buildSearchBody({ ...baseConfig, timeRange: "", country: "", includeDomains: "", excludeDomains: [] }, "q", void 0);
	assert.equal(minimal.max_results, baseConfig.maxResults, "falls back to configured cap when the seam passes no bound");
	assert.equal("time_range" in minimal, false);
	assert.equal("country" in minimal, false);
	assert.equal("include_domains" in minimal, false);
});

/* ------------------------------------------------------------------ config schema */

/** Validate through the Standard Schema interface cordis itself uses. */
function validate(Config, raw) {
	const result = Config["~standard"].validate(raw);
	if (result.issues) throw new Error(`ValidationError: ${result.issues.map((issue) => `${(issue.path ?? []).join(".")}: ${issue.message}`).join("; ")}`);
	return unwrap(result.value);
}

/** rc.2 schemas mark every field `.volatile()`, which wraps the parsed value in a reactive
* accessor (`{ get(): T, [cosmokit.volatile.write] }`). The runtime host calls `.get()` to read;
* tests on the raw parsed shape need to peek through the wrapper to keep their assertions simple. */
function unwrap(node) {
	if (node === null || typeof node !== "object") return node;
	if (typeof node.get === "function") return unwrap(node.get());
	if (Array.isArray(node)) return node.map(unwrap);
	const out = {};
	for (const [key, value] of Object.entries(node)) out[key] = unwrap(value);
	return out;
}

await test("Config defaults every field so a config-less install still mounts", () => {
	const parsed = validate(plugin.Config, {});
	assert.equal(parsed.apiKeyEnv, "TAVILY_API_KEY");
	assert.equal(parsed.baseURL, "https://api.tavily.com");
	assert.equal(parsed.topic, "general");
	assert.equal(parsed.searchDepth, "basic");
	assert.equal(parsed.includeAnswer, "basic");
	assert.equal(parsed.maxResults, 10);
	assert.equal(parsed.timeRange, "");
	assert.equal(parsed.maxConcurrentRequests, 2);
	assert.equal(parsed.minRequestGapMs, 150);
	assert.equal(parsed.cooldownMs, 5e3);
	assert.equal(parsed.maxRetries, 2);
});

await test("Config keeps a literal apiKey and rejects out-of-range values", () => {
	assert.equal(validate(plugin.Config, { apiKey: "tvly-x" }).apiKey, "tvly-x");
	assert.throws(() => validate(plugin.Config, { maxResults: 0 }));
	assert.throws(() => validate(plugin.Config, { searchDepth: "insane" }), /searchDepth/u);
});

await test("Config accepts a single-line comma list for the domain filters", () => {
	const parsed = validate(plugin.Config, { includeDomains: "a.com, b.com", excludeDomains: "spam.io" });
	assert.equal(parsed.includeDomains, "a.com, b.com");
	assert.deepEqual(plugin.resolveOptions(makeContext().ctx, { ...baseConfig, ...parsed }).includeDomains, ["a.com", "b.com"]);
});

await test("resolveOptions drops an unknown time_range instead of sending a 422-bound value", () => {
	const options = plugin.resolveOptions(makeContext().ctx, { ...baseConfig, timeRange: "fortnight" });
	assert.equal(options.timeRange, "");
	assert.equal("time_range" in plugin.buildSearchBody(options, "q", void 0), false);
});

/* ------------------------------------------------------------------ provider behaviour */

await test("registers the primary id and the alias", () => {
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-test" });
	assert.deepEqual(providers.map((provider) => provider.id), [plugin.PROVIDER_ID, plugin.PROVIDER_ID_ALIAS]);
	assert.equal(plugin.PROVIDER_ID, "tavily");
	assert.equal(providers[0].available(), true);
});

await test("available() is false without any credential source or with an unusable base URL", () => {
	assert.equal(new plugin.TavilySearchProvider(() => ({ baseURL })).available(), false, "no literal key and no resolver");
	assert.equal(new plugin.TavilySearchProvider(() => ({ baseURL, resolveApiKey: async () => void 0 })).available(), true, "a resolver counts as a source even if it later misses");
	assert.equal(new plugin.TavilySearchProvider(() => ({ apiKey: "tvly-x", baseURL: "not a url" })).available(), false);
	assert.equal(new plugin.TavilySearchProvider(() => ({ apiKey: "tvly-x", baseURL: "" })).available(), false);
});

await test("search() posts Bearer auth to /search and returns normalized sources", async () => {
	scriptOk();
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-abc" });
	const result = await providers[0].search({ query: "who is Leo Messi?", maxResults: 5 });
	assert.equal(server.count, 1);
	assert.equal(server.requests[0].url, "/search");
	assert.equal(server.requests[0].method, "POST");
	assert.equal(server.requests[0].authorization, "Bearer tvly-abc");
	assert.match(server.requests[0].userAgent, /dsh-web-search-tavily/u);
	assert.equal(JSON.parse(server.bodies[0]).max_results, 5, "the seam's bound is applied at the request layer");
	assert.equal(result.content, "An Argentine footballer.");
	assert.equal(result.sources.length, 3);
	assert.equal(result.truncated, false);
});

await test("resolves the key through the credentials service when config has none", async () => {
	scriptOk();
	const { ctx, providers } = makeContext("tvly-from-credentials");
	plugin.apply(ctx, baseConfig);
	const result = await providers[0].search({ query: "hello" });
	assert.equal(result.sources.length, 3);
	assert.equal(server.requests.at(-1).authorization, "Bearer tvly-from-credentials");
});

await test("missing credential fails as WEB_PROVIDER_CREDENTIAL_MISSING without a request", async () => {
	const before = server.count;
	const { ctx, providers } = makeContext(void 0);
	plugin.apply(ctx, baseConfig);
	await assert.rejects(() => providers[0].search({ query: "hello" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_CREDENTIAL_MISSING");
		assert.match(error.message, /TAVILY_API_KEY/u);
		return true;
	});
	assert.equal(server.count, before, "never contacts the provider without a key");
});

await test("HTTP 401 fails fast with the provider message and no retry", async () => {
	server.script.push({ status: 401, body: JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key." } }) });
	const before = server.count;
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-bad" });
	await assert.rejects(() => providers[0].search({ query: "hello" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		assert.match(error.message, /Unauthorized: missing or invalid API key/u);
		return true;
	});
	assert.equal(server.count, before + 1, "an invalid key is not replayed");
});

await test("HTTP 429 honours Retry-After and retries within the budget", async () => {
	server.script.push({ status: 429, body: JSON.stringify({ detail: { error: "Your request has been blocked due to excessive requests." } }), retryAfter: 1 });
	scriptOk();
	const before = server.count;
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok", cooldownMs: 1e3, maxRetries: 1 });
	const result = await providers[0].search({ query: "retry me" });
	assert.equal(result.sources.length, 3);
	assert.equal(server.count, before + 2, "one rate-limited attempt plus one success");
});

await test("a redirect response is refused, not followed with the key", async () => {
	// `redirect: "error"` makes undici surface a 3xx as a network failure; either way the
	// credential must never be replayed against the redirect target.
	server.script.push({ status: 302, body: "", headers: { location: `${baseURL}/search` } });
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok", maxRetries: 0 });
	await assert.rejects(() => providers[0].search({ query: "hello" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		return true;
	});
});

await test("a 429 that outlasts the retry budget surfaces its provider message", async () => {
	server.script.push({ status: 429, body: JSON.stringify({ detail: { error: "Your request has been blocked due to excessive requests." } }), retryAfter: 60 }, { status: 429, body: JSON.stringify({ detail: { error: "Your request has been blocked due to excessive requests." } }) });
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok", cooldownMs: 1e3, maxRetries: 1 });
	await assert.rejects(() => providers[0].search({ query: "burst" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		assert.match(error.message, /blocked due to excessive requests/u);
		return true;
	});
});

await test("empty results array is an error, not a silent empty list", async () => {
	server.script.push({ status: 200, body: JSON.stringify({ query: "x", results: [], images: [], response_time: 0.1 }) });
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok" });
	await assert.rejects(() => providers[0].search({ query: "obscure thing" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		assert.match(error.message, /returned no results/u);
		return true;
	});
});

await test("non-JSON success body reports WEB_PROVIDER_ERROR", async () => {
	server.script.push({ status: 200, body: "<html>gateway landed here</html>" });
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok" });
	await assert.rejects(() => providers[0].search({ query: "hello" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		assert.match(error.message, /unprocessable response body/u);
		return true;
	});
});

await test("cancelling mid-request yields WEB_ABORTED", async () => {
	server.delayMs = 600;
	scriptOk();
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok" });
	const controller = new AbortController();
	const pending = providers[0].search({ query: "slow" }, controller.signal);
	setTimeout(() => controller.abort(), 60);
	await assert.rejects(() => pending, (error) => {
		assert.equal(error.code, "WEB_ABORTED");
		return true;
	});
	server.delayMs = 0;
});

await test("concurrent identical queries coalesce into one HTTP request", async () => {
	scriptOk();
	const before = server.count;
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok" });
	const [a, b] = await Promise.all([providers[0].search({ query: "same query" }), providers[1].search({ query: "same query" })]);
	assert.equal(server.count, before + 1, "two aliases sharing one bucket collapse duplicates");
	assert.equal(a.sources.length, b.sources.length);
});

await test("minRequestGapMs spaces consecutive requests", async () => {
	scriptOk(2);
	const before = server.count;
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok", minRequestGapMs: 250 });
	const started = Date.now();
	await Promise.all([providers[0].search({ query: "one" }), providers[1].search({ query: "two" })]);
	assert.equal(server.count, before + 2);
	assert.ok(Date.now() - started >= 200, `expected >=200ms of spacing, saw ${Date.now() - started}ms`);
});

await test("a redirect response is refused, not followed with the key", async () => {
	// `redirect: "error"` must surface as WEB_PROVIDER_ERROR. The mock answers `/search` with 302
	// and every other path with a scripted error, so a rejection that names neither can only be
	// undici refusing to follow.
	const before = server.count;
	redirectsTo = `${baseURL}/never-contact`;
	const { ctx, providers } = makeContext();
	plugin.apply(ctx, { ...baseConfig, apiKey: "tvly-ok", maxRetries: 0 });
	await assert.rejects(() => providers[0].search({ query: "hello" }), (error) => {
		assert.equal(error.code, "WEB_PROVIDER_ERROR");
		assert.match(error.message, /Tavily search request failed/u);
		assert.doesNotMatch(error.message, /NEVER-CONTACTED/u);
		return true;
	});
	assert.equal(server.count, before + 1, "the redirect target was never contacted");
	redirectsTo = void 0;
});

await test("resolveOptions falls back to constants when config is sparse", () => {
	const { ctx } = makeContext();
	const options = plugin.resolveOptions(ctx, {});
	assert.equal(options.baseURL, "https://api.tavily.com");
	assert.equal(options.topic, "general");
	assert.equal(options.searchDepth, "basic");
	assert.equal(options.includeAnswer, "basic");
	assert.equal(options.maxResults, 10);
	assert.equal(options.apiKey, void 0);
	assert.equal(options.bucket, "tavily:TAVILY_API_KEY");
});

httpServer.close();
await rm(work, { recursive: true, force: true });
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
