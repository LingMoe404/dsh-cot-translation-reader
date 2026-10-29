/**
 * Display-only translation of reasoning for dsh-better-display's reading view.
 *
 * The reading view exposes `dsh-better-display.text-transform`; a registrant
 * returns the string it wants painted and never touches the session, the
 * transcript, or the fold. Translation therefore lives here: the Host half
 * exposes `cotTranslation` over two same-origin routes (the service itself is
 * Host-only), and this module turns their answers into painted text.
 */
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
export function reasoningFragments(text, running, maxTextChars) {
    const limit = Math.max(2, Math.floor(maxTextChars) || 2);
    const fragments = [];
    if (!text)
        return { fragments, tail: '' };
    const segments = [];
    let start = 0;
    for (const match of text.matchAll(PARAGRAPH_BREAK)) {
        const index = match.index ?? 0;
        segments.push({ body: text.slice(start, index), separator: match[0] });
        start = index + match[0].length;
    }
    segments.push({ body: text.slice(start), separator: '' });
    let tail = '';
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        const last = index === segments.length - 1;
        if (last && running) {
            tail = segment.body + segment.separator;
            break;
        }
        if (segment.body.trim() === '') {
            const previous = fragments.at(-1);
            if (previous)
                fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.body + segment.separator };
            else
                fragments.push({ body: '', suffix: segment.body + segment.separator });
            continue;
        }
        let body = segment.body;
        while (body.length > limit) {
            let cut = body.lastIndexOf(' ', limit);
            if (cut < Math.floor(limit / 2))
                cut = body.lastIndexOf('\n', limit);
            if (cut < Math.floor(limit / 2))
                cut = limit;
            fragments.push({ body: body.slice(0, cut), suffix: '' });
            body = body.slice(cut);
        }
        if (body !== '')
            fragments.push({ body, suffix: segment.separator });
        else if (fragments.length > 0) {
            const previous = fragments[fragments.length - 1];
            fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.separator };
        }
    }
    return { fragments, tail };
}
/** Build the transformer the reading view registers, plus a disposer. */
export function createReasoningTransformer(client, onError = () => { }) {
    const entries = new Map();
    const listeners = new Set();
    let disposed = false;
    let unavailable = false;
    let target;
    let preparing;
    const notify = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            }
            catch (error) {
                onError(error);
            }
        }
    };
    const prepare = () => {
        if (target || preparing || unavailable)
            return;
        preparing = client.limits(new AbortController().signal).then((limits) => {
            target = limits;
            notify();
        }).catch((error) => {
            // A missing route (official bundle off) or a failed read is not retried
            // on every paint; the source text simply stays on screen.
            unavailable = true;
            if (!disposed)
                onError(error);
        }).finally(() => {
            preparing = undefined;
        });
    };
    const assemble = (entry) => {
        let text = '';
        for (const fragment of entry.fragments) {
            text += (entry.results.get(fragment.body) ?? fragment.body) + fragment.suffix;
        }
        return text + entry.tail;
    };
    const run = async (entry) => {
        if (disposed || entry.pending)
            return;
        const current = target;
        if (!current)
            return;
        entry.pending = true;
        const controller = new AbortController();
        entry.controller = controller;
        try {
            for (let index = 0; index < entry.fragments.length; index += 1) {
                const fragment = entry.fragments[index];
                if (entry.results.has(fragment.body) || fragment.body.trim() === '')
                    continue;
                const translated = await client.translate(fragment.body, controller.signal);
                if (disposed || controller.signal.aborted)
                    return;
                entry.results.set(fragment.body, translated);
                entry.rendered = assemble(entry);
                notify();
            }
        }
        catch (error) {
            // Keep the source text on screen; the next paint can try again.
            if (!disposed && !controller.signal.aborted)
                onError(error);
        }
        finally {
            entry.pending = false;
            entry.controller = undefined;
            if (!disposed && entry.dirty)
                schedule(entry);
        }
    };
    const schedule = (entry) => {
        if (disposed || entry.pending || entry.scheduled)
            return;
        entry.scheduled = true;
        queueMicrotask(() => {
            entry.scheduled = false;
            if (!disposed)
                void run(entry);
        });
    };
    const ensure = (blockKey) => {
        const existing = entries.get(blockKey);
        if (existing)
            return existing;
        const entry = { source: '', streaming: false, fragments: [], tail: '', results: new Map(), pending: false, scheduled: false, dirty: false };
        entries.set(blockKey, entry);
        if (entries.size > MAX_BLOCKS) {
            const oldest = entries.keys().next().value;
            if (oldest !== undefined && oldest !== blockKey) {
                entries.get(oldest)?.controller?.abort();
                entries.delete(oldest);
            }
        }
        return entry;
    };
    const transformer = {
        read(request) {
            if (disposed || unavailable || request.kind !== 'reasoning' || request.source === 'tool')
                return undefined;
            const entry = ensure(request.blockKey);
            if (entry.source !== request.text || entry.streaming !== request.streaming) {
                entry.source = request.text;
                entry.streaming = request.streaming;
                entry.dirty = true;
            }
            prepare();
            const current = target;
            if (!current)
                return entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming };
            if (entry.dirty) {
                entry.dirty = false;
                const next = reasoningFragments(entry.source, request.streaming, current.maxTextChars);
                entry.fragments = next.fragments;
                entry.tail = next.tail;
                // Until one fragment is translated, painting the source back would be a
                // no-op replacement; return undefined so the reading view keeps its own.
                entry.rendered = entry.results.size > 0 ? assemble(entry) : undefined;
                schedule(entry);
            }
            return entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
    return {
        transformer,
        dispose() {
            disposed = true;
            for (const entry of entries.values())
                entry.controller?.abort();
            entries.clear();
            listeners.clear();
        },
    };
}
//# sourceMappingURL=transformer.js.map