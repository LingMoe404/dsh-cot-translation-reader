// src/index.ts
const name = "cot-translation-reader";
/** Routes exist only while the Host is mounted, so wait for the web server. */
const inject = ["webServer"];
const ROUTE_LIMITS = "/cot-translation-reader/limits";
const ROUTE_TRANSLATE = "/cot-translation-reader/translate";
const ROUTE_STATUS = "/cot-translation-reader/status";
const MAX_BODY_BYTES = 65536;
/** Call counters, so a restart can be checked from outside the browser. */
const calls = {
	limits: 0,
	translate: 0,
	lastError: ""
};
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
/**
* Resolve `auto` to a concrete tag.
*
* The official browser half resolves `auto` from the UI locale before it calls
* the Host; this route has no UI locale, so it uses the request's
* `Accept-Language`. Providers reject `to=auto` outright (Bing answers 400),
* so leaving it unresolved would fail every request.
*/
function targetLanguageOf(req, requested) {
	if (requested !== "auto") return requested;
	const header = req.headers["accept-language"];
	const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.split(";")[0]?.trim();
	return first && first.length > 0 ? first : "en";
}
/**
* Register the translation routes.
*
* @param ctx - Host plugin context.
* @returns disposer removing both routes.
*/
function apply(ctx) {
	const server = ctx.webServer;
	if (!server) return () => {};
	const lookup = (name) => ctx.get?.call(ctx, name);
	const service = () => lookup("cotTranslation");
	const translator = () => lookup("translator");
	const available = () => translator() !== void 0 || service() !== void 0;
	const disposeLimits = server.register({
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
	const disposeTranslate = server.register({
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
			try {
				const parsed = JSON.parse(await readBody(req));
				if (parsed && typeof parsed === "object" && typeof parsed.text === "string") text = parsed.text;
			} catch {
				sendJson(res, 400, { error: "bad-request" });
				return;
			}
			if (text.trim() === "") {
				sendJson(res, 400, { error: "empty-text" });
				return;
			}
			try {
				let requested = "auto";
				let provider;
				if (current) {
					const snapshot = await current.limits(new AbortController().signal);
					requested = snapshot.preferences.targetLanguage;
					provider = snapshot.preferences.provider;
				}
				const targetLanguage = targetLanguageOf(req, requested);
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
				sendJson(res, 200, { text: translated });
			} catch (error) {
				const code = error.code;
				const message = error instanceof Error ? error.message : String(error);
				calls.lastError = typeof code === "string" ? `${code}: ${message}` : message;
				sendJson(res, 502, { error: "translate-failed" });
			}
		}
	});
	const disposeStatus = server.register({
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
		disposeLimits();
		disposeTranslate();
		disposeStatus();
	};
}
export { apply, inject, name };
