window.__ModuleLoader__.load({
	id: "dsh-cot-translation-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// src/client/transformer.ts
		/** Blank-line paragraph breaks, retaining their exact characters. */
		const PARAGRAPH_BREAK = /\n[ \t]*\n[ \t]*/g;
		/** Mounted blocks retained before the oldest is dropped. */
		const MAX_BLOCKS = 40;
		/**
		* Split reasoning into request-sized fragments.
		*
		* Completed paragraphs are translated whole; a paragraph longer than one
		* request is cut at whitespace and only its leading request-sized prefixes are
		* translated. While the model is still reasoning, the trailing paragraph stays
		* original rather than being sent half-written.
		*
		* @param text - current reasoning text, including its whitespace.
		* @param running - whether the final paragraph may still grow.
		* @param maxTextChars - translator's UTF-16 limit for one request.
		* @returns fragments plus the untouched tail that is never submitted.
		*/
		function reasoningFragments(text, running, maxTextChars) {
			const limit = Math.max(2, Math.floor(maxTextChars) || 2);
			const fragments = [];
			if (!text) return {
				fragments,
				tail: ""
			};
			const segments = [];
			let start = 0;
			for (const match of text.matchAll(PARAGRAPH_BREAK)) {
				const index = match.index ?? 0;
				segments.push({
					body: text.slice(start, index),
					separator: match[0]
				});
				start = index + match[0].length;
			}
			segments.push({
				body: text.slice(start),
				separator: ""
			});
			let tail = "";
			for (let index = 0; index < segments.length; index += 1) {
				const segment = segments[index];
				if (index === segments.length - 1 && running) {
					tail = segment.body + segment.separator;
					break;
				}
				if (segment.body.trim() === "") {
					const previous = fragments.at(-1);
					if (previous) fragments[fragments.length - 1] = {
						body: previous.body,
						suffix: previous.suffix + segment.body + segment.separator
					};
					else fragments.push({
						body: "",
						suffix: segment.body + segment.separator
					});
					continue;
				}
				let body = segment.body;
				while (body.length > limit) {
					let cut = body.lastIndexOf(" ", limit);
					if (cut < Math.floor(limit / 2)) cut = body.lastIndexOf("\n", limit);
					if (cut < Math.floor(limit / 2)) cut = limit;
					fragments.push({
						body: body.slice(0, cut),
						suffix: ""
					});
					body = body.slice(cut);
				}
				if (body !== "") fragments.push({
					body,
					suffix: segment.separator
				});
				else if (fragments.length > 0) {
					const previous = fragments[fragments.length - 1];
					fragments[fragments.length - 1] = {
						body: previous.body,
						suffix: previous.suffix + segment.separator
					};
				}
			}
			return {
				fragments,
				tail
			};
		}
		/** Build the transformer the reading view registers, plus a disposer. */
		function createReasoningTransformer(client, onError = () => {}) {
			const entries = /* @__PURE__ */ new Map();
			const listeners = /* @__PURE__ */ new Set();
			let disposed = false;
			let unavailable = false;
			let target;
			let preparing;
			const notify = () => {
				for (const listener of [...listeners]) try {
					listener();
				} catch (error) {
					onError(error);
				}
			};
			const prepare = () => {
				if (target || preparing || unavailable) return;
				preparing = client.limits(new AbortController().signal).then((limits) => {
					target = limits;
					notify();
				}).catch((error) => {
					unavailable = true;
					if (!disposed) onError(error);
				}).finally(() => {
					preparing = void 0;
				});
			};
			const assemble = (entry) => {
				let text = "";
				for (const fragment of entry.fragments) text += (entry.results.get(fragment.body) ?? fragment.body) + fragment.suffix;
				return text + entry.tail;
			};
			const run = async (entry) => {
				if (disposed || entry.pending) return;
				if (!target) return;
				entry.pending = true;
				const controller = new AbortController();
				entry.controller = controller;
				try {
					for (let index = 0; index < entry.fragments.length; index += 1) {
						const fragment = entry.fragments[index];
						if (entry.results.has(fragment.body) || fragment.body.trim() === "") continue;
						const translated = await client.translate(fragment.body, controller.signal);
						if (disposed || controller.signal.aborted) return;
						entry.results.set(fragment.body, translated);
						entry.rendered = assemble(entry);
						notify();
					}
				} catch (error) {
					if (!disposed && !controller.signal.aborted) onError(error);
				} finally {
					entry.pending = false;
					entry.controller = void 0;
					if (!disposed && entry.dirty) schedule(entry);
				}
			};
			const schedule = (entry) => {
				if (disposed || entry.pending || entry.scheduled) return;
				entry.scheduled = true;
				queueMicrotask(() => {
					entry.scheduled = false;
					if (!disposed) run(entry);
				});
			};
			const ensure = (blockKey) => {
				const existing = entries.get(blockKey);
				if (existing) return existing;
				const entry = {
					source: "",
					streaming: false,
					fragments: [],
					tail: "",
					results: /* @__PURE__ */ new Map(),
					pending: false,
					scheduled: false,
					dirty: false
				};
				entries.set(blockKey, entry);
				if (entries.size > MAX_BLOCKS) {
					const oldest = entries.keys().next().value;
					if (oldest !== void 0 && oldest !== blockKey) {
						entries.get(oldest)?.controller?.abort();
						entries.delete(oldest);
					}
				}
				return entry;
			};
			return {
				transformer: {
					read(request) {
						if (disposed || unavailable || request.kind !== "reasoning" || request.source === "tool") return void 0;
						const entry = ensure(request.blockKey);
						if (entry.source !== request.text || entry.streaming !== request.streaming) {
							entry.source = request.text;
							entry.streaming = request.streaming;
							entry.dirty = true;
						}
						prepare();
						const current = target;
						if (!current) return entry.rendered === void 0 ? void 0 : {
							text: entry.rendered,
							final: !request.streaming
						};
						if (entry.dirty) {
							entry.dirty = false;
							const next = reasoningFragments(entry.source, request.streaming, current.maxTextChars);
							entry.fragments = next.fragments;
							entry.tail = next.tail;
							entry.rendered = entry.results.size > 0 ? assemble(entry) : void 0;
							schedule(entry);
						}
						return entry.rendered === void 0 ? void 0 : {
							text: entry.rendered,
							final: !request.streaming
						};
					},
					subscribe(listener) {
						listeners.add(listener);
						return () => {
							listeners.delete(listener);
						};
					}
				},
				dispose() {
					disposed = true;
					for (const entry of entries.values()) entry.controller?.abort();
					entries.clear();
					listeners.clear();
				}
			};
		}
		// src/client/index.ts
		/** Reading view seam, documented in dsh-better-display's `docs/extension-points.md`. */
		const SEAM_SERVICE = "dsh-better-display.text-transform";
		/** Same-origin Host routes registered by `src/index.ts`. */
		const ROUTE_LIMITS = "/cot-translation-reader/limits";
		const ROUTE_TRANSLATE = "/cot-translation-reader/translate";
		/** Every service lookup is optional: this plugin must not break a host without them. */
		function lookup(ctx, service) {
			const get = ctx.get;
			if (typeof get !== "function") return void 0;
			return get.call(ctx, service);
		}
		/**
		* Browser side of the translation routes.
		*
		* The official bundle's `cotTranslation` service lives on the Host, so the
		* browser asks the Host half instead of reaching for that name directly.
		*
		* @returns client used by the transformer.
		*/
		function createHttpTranslationClient() {
			return {
				async limits(signal) {
					const response = await fetch(ROUTE_LIMITS, {
						signal,
						headers: { accept: "application/json" }
					});
					if (!response.ok) throw new Error(`limits ${response.status}`);
					const body = await response.json();
					if (typeof body.maxTextChars !== "number") throw new Error("limits payload");
					return {
						maxTextChars: body.maxTextChars,
						provider: body.provider,
						targetLanguage: body.targetLanguage
					};
				},
				async translate(text, signal) {
					const response = await fetch(ROUTE_TRANSLATE, {
						method: "POST",
						signal,
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text })
					});
					if (!response.ok) throw new Error(`translate ${response.status}`);
					const body = await response.json();
					if (typeof body.text !== "string") throw new Error("translate payload");
					return body.text;
				}
			};
		}
		const name = "cot-translation-reader";
		/**
		* The reading view only paints translated reasoning when it offers the seam,
		* so wait for it instead of mounting without a place to contribute.
		*/
		const inject = [SEAM_SERVICE];
		/**
		* Register a display-only reasoning transformer backed by the Host routes.
		*
		* @param ctx - browser plugin context.
		* @returns disposer that withdraws the transformer and aborts pending requests.
		*/
		function apply(ctx) {
			const seam = lookup(ctx, SEAM_SERVICE);
			if (!seam) return () => {};
			const { transformer, dispose } = createReasoningTransformer(createHttpTranslationClient(), (error) => {
				console.warn("[cot-translation-reader] reasoning translation failed; keeping the source text", error);
			});
			const unregister = seam.register("reasoning", transformer);
			return () => {
				unregister();
				dispose();
			};
		}
		exports.apply = apply;
		exports.createHttpTranslationClient = createHttpTranslationClient;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map