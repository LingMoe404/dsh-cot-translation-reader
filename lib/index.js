// src/language.ts
/** Return a canonical, concrete BCP 47 tag, never a wildcard or auto sentinel. */
function concreteLanguageTag(value) {
	if (typeof value !== "string" || value.length > 255) return void 0;
	const tag = value.trim();
	if (!tag || tag === "*" || tag.toLowerCase() === "auto") return void 0;
	try {
		return Intl.getCanonicalLocales(tag)[0];
	} catch {
		return;
	}
}
// src/index.ts
const name = "cot-translation-reader";
/** Routes exist only while the Host is mounted, so wait for the web server. */
const inject = ["webServer"];
const ROUTE_LIMITS = "/cot-translation-reader/limits";
const ROUTE_TRANSLATE = "/cot-translation-reader/translate";
const ROUTE_STATUS = "/cot-translation-reader/status";
const MAX_BODY_BYTES = 65536;
function sendJson(res, status, body) {
	res.setHeader("Content-Type", "application/json");
	res.setHeader("Cache-Control", "no-store");
	res.statusCode = status;
	res.end(JSON.stringify(body));
}
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Resolve preferences, browser locale, then weighted concrete header tags. */
function targetLanguageOf(req, requested, locale) {
	const explicit = concreteLanguageTag(requested);
	if (explicit) return explicit;
	const browser = concreteLanguageTag(locale);
	if (browser) return browser;
	const header = req.headers["accept-language"];
	const raw = Array.isArray(header) ? header.join(",") : header;
	if (!raw || raw.length > 8192) return "en";
	let best;
	let bestQuality = 0;
	for (const entry of raw.split(",")) {
		const [range, ...parameters] = entry.split(";");
		const tag = concreteLanguageTag(range);
		if (!tag) continue;
		let quality = 1;
		if (parameters.length > 0) {
			if (parameters.length !== 1) continue;
			const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?|\.\d{1,3})$/i.exec(parameters[0].trim());
			if (!match) continue;
			quality = Number(match[1]);
		}
		if (quality > bestQuality) {
			best = tag;
			bestQuality = quality;
		}
	}
	return best ?? "en";
}
/** Servers already carrying this plugin's routes; a duplicate mount must not crash. */
const mounted = /* @__PURE__ */ new WeakSet();
/** The path is already served by another copy of this plugin: keep that copy. */
function isDuplicateRoute(error) {
	const message = error instanceof Error ? error.message : String(error);
	return /duplicate (?:exact|prefix) route/i.test(message);
}
/**
* Register one route, tolerating a duplicate from another module instance.
*
* The market's update verification can compose the same plugin twice through
* separate package copies. A per-server WeakSet cannot see the other copy, so
* the server's own duplicate-route error is the only shared signal. Treating
* it as "already mounted" keeps the first copy serving instead of aborting
* startup.
*/
function registerRoute(server, route) {
	try {
		return server.register(route);
	} catch (error) {
		if (isDuplicateRoute(error)) return () => {};
		throw error;
	}
}
/**
* Register the translation routes.
*
* A profile can compose the same entry twice (for example a market update
* verification), and `webServer.register` rejects duplicate exact paths. The
* second activation is a no-op rather than a fatal startup error; it must not
* own the first activation's disposer either.
*
* @param ctx - Host plugin context.
* @returns disposer removing both routes.
*/
function apply(ctx) {
	const server = ctx.webServer;
	if (!server) return () => {};
	if (mounted.has(server)) return () => {};
	mounted.add(server);
	const calls = {
		limits: 0,
		translate: 0,
		attempts: 0,
		failed: 0,
		pending: 0,
		lastError: "",
		lastRequest: void 0,
		lastOutcome: "idle"
	};
	const lookup = (name) => ctx.get?.call(ctx, name);
	const service = () => lookup("cotTranslation");
	const translator = () => lookup("translator");
	const available = () => translator() !== void 0 || service() !== void 0;
	const disposeLimits = registerRoute(server, {
		kind: "exact",
		path: ROUTE_LIMITS,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end();
				return;
			}
			calls.limits += 1;
			const current = service();
			if (!current) {
				const t = translator();
				if (!t) {
					calls.lastError = "translation-unavailable";
					sendJson(res, 503, { error: "translation-unavailable" });
					return;
				}
				sendJson(res, 200, {
					maxTextChars: t.maxTextChars ?? 4e3,
					provider: "bing",
					targetLanguage: "auto"
				});
				return;
			}
			try {
				const snapshot = await current.limits(new AbortController().signal);
				sendJson(res, 200, {
					maxTextChars: snapshot.maxTextChars,
					provider: snapshot.preferences.provider,
					targetLanguage: snapshot.preferences.targetLanguage
				});
			} catch (error) {
				calls.lastError = error instanceof Error ? error.message : String(error);
				sendJson(res, 502, { error: "limits-failed" });
			}
		}
	});
	const disposeTranslate = registerRoute(server, {
		kind: "exact",
		path: ROUTE_TRANSLATE,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				res.statusCode = 405;
				res.end();
				return;
			}
			const current = service();
			const direct = translator();
			if (!current && !direct) {
				calls.lastError = "translation-unavailable";
				sendJson(res, 503, { error: "translation-unavailable" });
				return;
			}
			let text = "";
			let locale;
			try {
				const parsed = JSON.parse(await readBody(req));
				if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
					text = parsed.text;
					locale = parsed.locale;
				}
			} catch {
				sendJson(res, 400, { error: "bad-request" });
				return;
			}
			if (text.trim() === "") {
				sendJson(res, 400, { error: "empty-text" });
				return;
			}
			calls.attempts += 1;
			calls.pending += 1;
			try {
				let requested = "auto";
				let provider;
				if (current) {
					const snapshot = await current.limits(new AbortController().signal);
					requested = snapshot.preferences.targetLanguage;
					provider = snapshot.preferences.provider;
				}
				const targetLanguage = targetLanguageOf(req, requested, locale);
				calls.lastRequest = {
					textChars: text.length,
					targetLanguage,
					provider
				};
				const translated = direct ? await direct.translate(direct.resolve({
					text,
					targetLanguage,
					provider
				}), new AbortController().signal) : await current.translate({
					text,
					targetLanguage,
					provider
				}, new AbortController().signal);
				calls.translate += 1;
				calls.lastError = "";
				calls.lastOutcome = "success";
				sendJson(res, 200, { text: translated });
			} catch (error) {
				const code = error.code;
				const message = error instanceof Error ? error.message : String(error);
				calls.failed += 1;
				calls.lastOutcome = "failure";
				calls.lastError = typeof code === "string" ? `${code}: ${message}` : message;
				sendJson(res, 502, { error: "translate-failed" });
			} finally {
				calls.pending -= 1;
			}
		}
	});
	const disposeStatus = registerRoute(server, {
		kind: "exact",
		path: ROUTE_STATUS,
		handler: (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end();
				return;
			}
			sendJson(res, 200, {
				...calls,
				available: available()
			});
		}
	});
	return () => {
		mounted.delete(server);
		disposeLimits();
		disposeTranslate();
		disposeStatus();
	};
}
export { apply, inject, name };
