window.__ModuleLoader__.load({
	id: "dsh-cot-translation-reader",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// src/client/transformer.ts
		/** Blank-line paragraph breaks, retaining their exact characters. */
		const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n[ \t]*/g;
		/** Hard admission bound; a repaint must never evict another recently read card. */
		const MAX_BLOCKS = 512;
		/** Reclaim only entries that have not participated in reads for five minutes. */
		const BLOCK_IDLE_MS = 3e5;
		/** Cooldown before retrying limits after a failed read (ms). */
		const RETRY_MS = 8e3;
		/** Automatic retries for one fragment after a transient provider failure. */
		const MAX_RETRIES = 3;
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
			let retryAt = 0;
			let target;
			let preparing;
			/** One request at a time: bursts are what the anonymous provider pushes back on. */
			let chain = Promise.resolve();
			const serial = (task) => {
				const next = chain.then(task, task);
				chain = next.then(() => void 0, () => void 0);
				return next;
			};
			const notify = () => {
				for (const listener of [...listeners]) try {
					listener();
				} catch (error) {
					onError(error);
				}
			};
			const prepare = () => {
				if (target || preparing) return;
				if (Date.now() < retryAt) return;
				preparing = client.limits(new AbortController().signal).then((limits) => {
					target = limits;
					notify();
				}).catch((error) => {
					retryAt = Date.now() + RETRY_MS;
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
				if (disposed || !entry.active || entry.pending || entry.retryTimer !== void 0) return;
				if (!target) return;
				entry.pending = true;
				const controller = new AbortController();
				entry.controller = controller;
				const fragments = entry.fragments;
				try {
					for (const fragment of fragments) {
						if (entry.fragments !== fragments) break;
						if (entry.results.has(fragment.body) || fragment.body.trim() === "") continue;
						const translated = await serial(() => {
							controller.signal.throwIfAborted();
							return client.translate(fragment.body, controller.signal);
						});
						if (disposed || controller.signal.aborted) return;
						entry.results.set(fragment.body, translated);
						entry.failures = 0;
						entry.rendered = assemble(entry);
						notify();
					}
				} catch (error) {
					if (!disposed && !controller.signal.aborted) {
						onError(error);
						entry.failures += 1;
						if (entry.failures <= MAX_RETRIES) {
							const delay = RETRY_MS * entry.failures;
							entry.retryTimer = setTimeout(() => {
								entry.retryTimer = void 0;
								schedule(entry);
							}, delay);
						}
					}
				} finally {
					entry.pending = false;
					entry.controller = void 0;
					if (entry.dirty || entry.fragments !== fragments) schedule(entry);
				}
			};
			const schedule = (entry) => {
				if (disposed || !entry.active || entry.pending || entry.scheduled || entry.retryTimer !== void 0) return;
				entry.scheduled = true;
				queueMicrotask(() => {
					entry.scheduled = false;
					if (!disposed) run(entry);
				});
			};
			const retire = (entry) => {
				entry.active = false;
				entry.controller?.abort();
				if (entry.retryTimer !== void 0) clearTimeout(entry.retryTimer);
				entry.retryTimer = void 0;
			};
			const ensure = (blockKey) => {
				const now = Date.now();
				const existing = entries.get(blockKey);
				if (existing) {
					existing.lastReadAt = now;
					return existing;
				}
				if (entries.size >= MAX_BLOCKS) {
					for (const [key, candidate] of entries) {
						if (now - candidate.lastReadAt < BLOCK_IDLE_MS) continue;
						retire(candidate);
						entries.delete(key);
						break;
					}
					if (entries.size >= MAX_BLOCKS) return void 0;
				}
				const entry = {
					lastReadAt: now,
					source: "",
					streaming: false,
					showOriginal: false,
					fragments: [],
					tail: "",
					results: /* @__PURE__ */ new Map(),
					pending: false,
					scheduled: false,
					dirty: false,
					failures: 0,
					active: true
				};
				entries.set(blockKey, entry);
				return entry;
			};
			return {
				transformer: {
					read(request) {
						if (disposed || request.kind !== "reasoning" || request.source === "tool") return void 0;
						const entry = ensure(request.blockKey);
						if (!entry) return void 0;
						if (entry.source !== request.text || entry.streaming !== request.streaming) {
							entry.source = request.text;
							entry.streaming = request.streaming;
							entry.dirty = true;
						}
						prepare();
						const current = target;
						if (!current) return entry.showOriginal ? {
							text: request.text,
							final: !request.streaming
						} : entry.rendered === void 0 ? void 0 : {
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
						if (entry.showOriginal) return {
							text: request.text,
							final: !request.streaming
						};
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
				setShowOriginal(blockKey, value) {
					const entry = entries.get(blockKey);
					if (!entry || entry.showOriginal === value) return;
					entry.showOriginal = value;
					notify();
				},
				getShowOriginal: (blockKey) => entries.get(blockKey)?.showOriginal ?? false,
				dispose() {
					disposed = true;
					for (const entry of entries.values()) retire(entry);
					entries.clear();
					listeners.clear();
				}
			};
		}
		// src/client/toggle.ts
		const CARD = "[data-reader-reasoning-card]";
		const HEADING = "[data-reader-reasoning-heading]";
		const BLOCK_KEY = "data-reader-reasoning-block-key";
		const BUTTON_FLAG = "data-cot-translation-toggle";
		const LABEL_ORIGINAL = "查看原文";
		const LABEL_TRANSLATED = "查看译文";
		const BUTTON_CSS = [
			"margin-left:auto",
			"padding:0 6px",
			"min-height:20px",
			"border:0",
			"border-radius:6px",
			"background:transparent",
			"color:inherit",
			"font:inherit",
			"font-size:12px",
			"line-height:20px",
			"cursor:pointer",
			"white-space:nowrap"
		].join(";");
		/** Never infer identity from source text, translated text, or card order. */
		function blockKeys(card) {
			const keys = /* @__PURE__ */ new Set();
			for (const node of card.querySelectorAll(`[${BLOCK_KEY}]`)) {
				if (node.closest(CARD) !== card) continue;
				const key = node.getAttribute(BLOCK_KEY);
				if (key) keys.add(key);
			}
			return [...keys];
		}
		function showingOriginal(api, keys) {
			return keys.length > 0 && keys.every((key) => api.getShowOriginal(key));
		}
		function paint(button, api, keys) {
			const original = showingOriginal(api, keys);
			const label = original ? LABEL_TRANSLATED : LABEL_ORIGINAL;
			const accessible = original ? "显示译文" : "显示原文";
			if (button.textContent !== label) button.textContent = label;
			if (button.getAttribute("aria-label") !== accessible) button.setAttribute("aria-label", accessible);
		}
		/** One initial scan, then only affected cards; no global display toggle. */
		function installOriginalToggle(api) {
			if (typeof document === "undefined") return () => {};
			let disposed = false;
			let started = false;
			const buttons = /* @__PURE__ */ new Set();
			const owned = /* @__PURE__ */ new WeakSet();
			const cardButtons = /* @__PURE__ */ new WeakMap();
			const onToggle = (button) => {
				if (disposed || !buttons.has(button) || !button.isConnected) return;
				const card = button.closest(CARD);
				if (!card) return;
				const keys = blockKeys(card);
				if (keys.length === 0) {
					syncCard(card);
					return;
				}
				const value = !showingOriginal(api, keys);
				for (const key of keys) api.setShowOriginal(key, value);
				syncCard(card);
			};
			const syncCard = (card) => {
				const previous = cardButtons.get(card);
				if (previous && (!previous.isConnected || previous.closest(CARD) === card)) buttons.delete(previous);
				cardButtons.delete(card);
				if (!card.isConnected) return;
				const heading = card.querySelector(HEADING);
				if (!heading || heading.closest(CARD) !== card) return;
				const keys = blockKeys(card);
				let button = heading.querySelector(`[${BUTTON_FLAG}]`);
				if (keys.length === 0) {
					if (button) {
						buttons.delete(button);
						button.remove();
					}
					return;
				}
				if (button && !owned.has(button)) {
					button.remove();
					button = null;
				}
				if (!button) {
					button = document.createElement("button");
					button.type = "button";
					button.setAttribute(BUTTON_FLAG, "");
					button.setAttribute("style", BUTTON_CSS);
					const control = button;
					control.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						onToggle(control);
					});
					owned.add(control);
					heading.appendChild(control);
				}
				paint(button, api, keys);
				cardButtons.set(card, button);
				buttons.add(button);
			};
			const related = `${CARD}, ${HEADING}, [${BUTTON_FLAG}], [${BLOCK_KEY}]`;
			const observer = new MutationObserver((records) => {
				if (disposed) return;
				const cards = /* @__PURE__ */ new Set();
				const collect = (node, removed) => {
					if (!(node instanceof Element)) return false;
					const elements = [...node.querySelectorAll(related)];
					if (node.matches(related)) elements.push(node);
					for (const element of elements) {
						if (removed && element.matches(`[${BUTTON_FLAG}]`)) buttons.delete(element);
						const card = element.closest(CARD);
						if (card) cards.add(card);
					}
					return elements.length > 0;
				};
				for (const record of records) {
					if (record.type === "attributes") {
						if (record.attributeName === BLOCK_KEY && record.target instanceof Element) {
							const card = record.target.closest(CARD);
							if (card) cards.add(card);
						}
						continue;
					}
					let changed = false;
					for (const node of record.removedNodes) changed = collect(node, true) || changed;
					for (const node of record.addedNodes) changed = collect(node, false) || changed;
					if (record.target instanceof Element && (changed || record.target.closest(HEADING))) {
						const card = record.target.closest(CARD);
						if (card) cards.add(card);
					}
				}
				for (const card of cards) syncCard(card);
			});
			const start = () => {
				if (disposed || started || !document.body) return;
				started = true;
				observer.observe(document.body, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: [BLOCK_KEY]
				});
				for (const card of document.querySelectorAll(CARD)) syncCard(card);
			};
			if (document.body) start();
			else document.addEventListener("DOMContentLoaded", start, { once: true });
			return () => {
				if (disposed) return;
				disposed = true;
				document.removeEventListener("DOMContentLoaded", start);
				observer.disconnect();
				for (const button of buttons) button.remove();
				buttons.clear();
			};
		}
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
		// src/client/locale.ts
		/** Resolve automatic translation from the UI first, never from HTTP wildcards. */
		function browserTranslationLocale(activeLocale) {
			const candidates = [activeLocale];
			if (typeof document !== "undefined") candidates.push(document.documentElement?.lang);
			if (typeof navigator !== "undefined") candidates.push(...navigator.languages ?? [], navigator.language);
			for (const candidate of candidates) {
				const tag = concreteLanguageTag(candidate);
				if (tag) return tag;
			}
			return "en";
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
		function createHttpTranslationClient(getLocale = () => browserTranslationLocale()) {
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
						body: JSON.stringify({
							text,
							locale: getLocale()
						})
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
			const { transformer, dispose, getShowOriginal, setShowOriginal } = createReasoningTransformer(createHttpTranslationClient(() => {
				return browserTranslationLocale(lookup(ctx, "locale")?.getSnapshot().active);
			}), (error) => {
				console.warn("[cot-translation-reader] reasoning translation failed; keeping the source text", error);
			});
			const removeToggle = installOriginalToggle({
				getShowOriginal,
				setShowOriginal
			});
			const unregister = seam.register("reasoning", transformer);
			return () => {
				unregister();
				removeToggle();
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