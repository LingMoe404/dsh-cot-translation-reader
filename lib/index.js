// src/index.ts
const name = "cot-translation-reader";
/** Routes exist only while the Host is mounted, so wait for the web server. */
const inject = ["webServer"];
const ROUTE_LIMITS = "/cot-translation-reader/limits";
const ROUTE_TRANSLATE = "/cot-translation-reader/translate";
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
	const service = () => ctx.get?.call(ctx, "cotTranslation");
	const disposeLimits = server.register({
		kind: "exact",
		path: ROUTE_LIMITS,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				res.statusCode = 405;
				res.end();
				return;
			}
			const current = service();
			if (!current) {
				sendJson(res, 503, { error: "cot-translation-unavailable" });
				return;
			}
			try {
				const snapshot = await current.limits(new AbortController().signal);
				sendJson(res, 200, {
					maxTextChars: snapshot.maxTextChars,
					provider: snapshot.preferences.provider,
					targetLanguage: snapshot.preferences.targetLanguage
				});
			} catch {
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
			if (!current) {
				sendJson(res, 503, { error: "cot-translation-unavailable" });
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
				const snapshot = await current.limits(new AbortController().signal);
				sendJson(res, 200, { text: await current.translate({
					text,
					targetLanguage: targetLanguageOf(req, snapshot.preferences.targetLanguage),
					provider: snapshot.preferences.provider
				}, new AbortController().signal) });
			} catch {
				sendJson(res, 502, { error: "translate-failed" });
			}
		}
	});
	return () => {
		disposeLimits();
		disposeTranslate();
	};
}
export { apply, inject, name };
