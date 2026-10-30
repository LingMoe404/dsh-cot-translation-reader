/**
 * Display-only translation of reasoning for dsh-better-display's reading view.
 *
 * The reading view exposes `dsh-better-display.text-transform`; a registrant
 * returns the string it wants painted and never touches the session, the
 * transcript, or the fold. Translation therefore lives here: the Host half
 * exposes `cotTranslation` over two same-origin routes (the service itself is
 * Host-only), and this module turns their answers into painted text.
 */

/** Kinds the reading view offers; only reasoning is translated here. */
export type DisplayTextKind = 'reasoning' | 'body';

/** One mounted block, as the reading view describes it. */
export interface DisplayTextRequest {
  readonly text: string;
  readonly streaming: boolean;
  readonly blockKey: string;
  readonly kind: DisplayTextKind;
  readonly source?: 'assistant' | 'user' | 'tool';
}

/** What the reading view paints instead of the source string. */
export interface DisplayText {
  readonly text: string;
  /** `false` keeps the live reveal open; `true` settles it. */
  readonly final: boolean;
}

/** Seam contract from dsh-better-display's `docs/extension-points.md`. */
export interface DisplayTextTransformer {
  read(request: DisplayTextRequest): DisplayText | undefined;
  subscribe?(listener: () => void): () => void;
}

/** Routing the Host accepted before any text is sent. */
export interface TranslationTarget {
  readonly maxTextChars: number;
  readonly provider: string;
  readonly targetLanguage: string;
}

/** Same-origin calls into the Host half. */
export interface TranslationClient {
  limits(signal: AbortSignal): Promise<TranslationTarget>;
  translate(text: string, signal: AbortSignal): Promise<string>;
}

/** One translated slice of the source. */
export interface ReasoningFragment {
  /** Text submitted for translation; replaced by the result. */
  readonly body: string;
  /** Whitespace after the body, kept verbatim. */
  readonly suffix: string;
}

/** Blank-line paragraph breaks, retaining their exact characters. */
const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n[ \t]*/g;

/** Hard admission bound; a repaint must never evict another recently read card. */
const MAX_BLOCKS = 512;
/** Reclaim only entries that have not participated in reads for five minutes. */
const BLOCK_IDLE_MS = 5 * 60 * 1000;

/** Cooldown before retrying limits after a failed read (ms). */
const RETRY_MS = 8000;

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
export function reasoningFragments(text: string, running: boolean, maxTextChars: number): {
  fragments: ReasoningFragment[];
  tail: string;
} {
  const limit = Math.max(2, Math.floor(maxTextChars) || 2);
  const fragments: ReasoningFragment[] = [];
  if (!text) return { fragments, tail: '' };

  const segments: Array<{ body: string; separator: string }> = [];
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
      if (previous) fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.body + segment.separator };
      else fragments.push({ body: '', suffix: segment.body + segment.separator });
      continue;
    }
    let body = segment.body;
    while (body.length > limit) {
      let cut = body.lastIndexOf(' ', limit);
      if (cut < Math.floor(limit / 2)) cut = body.lastIndexOf('\n', limit);
      if (cut < Math.floor(limit / 2)) cut = limit;
      fragments.push({ body: body.slice(0, cut), suffix: '' });
      body = body.slice(cut);
    }
    if (body !== '') fragments.push({ body, suffix: segment.separator });
    else if (fragments.length > 0) {
      const previous = fragments[fragments.length - 1];
      fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.separator };
    }
  }
  return { fragments, tail };
}

interface Entry {
  lastReadAt: number;
  source: string;
  streaming: boolean;
  showOriginal: boolean;
  fragments: ReasoningFragment[];
  tail: string;
  readonly results: Map<string, string>;
  rendered?: string;
  pending: boolean;
  scheduled: boolean;
  dirty: boolean;
  failures: number;
  active: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}

/** Build the transformer the reading view registers, plus a disposer. */
export function createReasoningTransformer(
  client: TranslationClient,
  onError: (error: unknown) => void = () => {},
): {
  transformer: DisplayTextTransformer;
  /** Switch one admitted reasoning card between its translation and source. */
  setShowOriginal(blockKey: string, value: boolean): void;
  getShowOriginal(blockKey: string): boolean;
  dispose(): void;
} {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let disposed = false;
  let retryAt = 0;
  let target: TranslationTarget | undefined;
  let preparing: Promise<void> | undefined;
  /** One request at a time: bursts are what the anonymous provider pushes back on. */
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        onError(error);
      }
    }
  };

  const prepare = () => {
    if (target || preparing) return;
    if (Date.now() < retryAt) return;
    preparing = client.limits(new AbortController().signal).then((limits) => {
      target = limits;
      notify();
    }).catch((error: unknown) => {
      // Not permanent: the first paint can run before the Host half (or the
      // official bundle's service) is up, and a later paint must be able to retry.
      retryAt = Date.now() + RETRY_MS;
      if (!disposed) onError(error);
    }).finally(() => {
      preparing = undefined;
    });
  };

  const assemble = (entry: Entry): string => {
    let text = '';
    for (const fragment of entry.fragments) {
      text += (entry.results.get(fragment.body) ?? fragment.body) + fragment.suffix;
    }
    return text + entry.tail;
  };

  const run = async (entry: Entry): Promise<void> => {
    if (disposed || !entry.active || entry.pending || entry.retryTimer !== undefined) return;
    const current = target;
    if (!current) return;
    entry.pending = true;
    const controller = new AbortController();
    entry.controller = controller;
    const fragments = entry.fragments;
    try {
      for (const fragment of fragments) {
        // A repaint may replace the fragment list while a request is in flight.
        // Finish that request, then restart against the latest source below.
        if (entry.fragments !== fragments) break;
        if (entry.results.has(fragment.body) || fragment.body.trim() === '') continue;
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
      // Keep the source text on screen and try again shortly: the first request
      // of a session can land while the Host half is still warming up.
      if (!disposed && !controller.signal.aborted) {
        onError(error);
        entry.failures += 1;
        if (entry.failures <= MAX_RETRIES) {
          const delay = RETRY_MS * entry.failures;
          entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            schedule(entry);
          }, delay);
        }
      }
    } finally {
      entry.pending = false;
      entry.controller = undefined;
      if (entry.dirty || entry.fragments !== fragments) schedule(entry);
    }
  };

  const schedule = (entry: Entry) => {
    if (disposed || !entry.active || entry.pending || entry.scheduled || entry.retryTimer !== undefined) return;
    entry.scheduled = true;
    queueMicrotask(() => {
      entry.scheduled = false;
      if (!disposed) void run(entry);
    });
  };

  const retire = (entry: Entry) => {
    entry.active = false;
    entry.controller?.abort();
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
    entry.retryTimer = undefined;
  };

  const ensure = (blockKey: string): Entry | undefined => {
    const now = Date.now();
    const existing = entries.get(blockKey);
    if (existing) {
      existing.lastReadAt = now;
      return existing;
    }
    if (entries.size >= MAX_BLOCKS) {
      // The seam broadcasts every update to all cards. Evicting a recently read
      // card here would make the next sweep evict its replacement indefinitely.
      // At capacity, reclaim only genuinely idle work; otherwise show source.
      for (const [key, candidate] of entries) {
        if (now - candidate.lastReadAt < BLOCK_IDLE_MS) continue;
        retire(candidate);
        entries.delete(key);
        break;
      }
      if (entries.size >= MAX_BLOCKS) return undefined;
    }
    const entry: Entry = { lastReadAt: now, source: '', streaming: false, showOriginal: false, fragments: [], tail: '', results: new Map(), pending: false, scheduled: false, dirty: false, failures: 0, active: true };
    entries.set(blockKey, entry);
    return entry;
  };

  const transformer: DisplayTextTransformer = {
    read(request) {
      if (disposed || request.kind !== 'reasoning' || request.source === 'tool') return undefined;
      const entry = ensure(request.blockKey);
      if (!entry) return undefined;
      if (entry.source !== request.text || entry.streaming !== request.streaming) {
        entry.source = request.text;
        entry.streaming = request.streaming;
        entry.dirty = true;
      }
      prepare();
      const current = target;
      if (!current) return entry.showOriginal
        ? { text: request.text, final: !request.streaming }
        : entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming };
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
      // Original is an explicit replacement: undefined would leave a previously
      // painted translation visible. Always use this read's growing source.
      if (entry.showOriginal) return { text: request.text, final: !request.streaming };
      return entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  return {
    transformer,
    setShowOriginal(blockKey: string, value: boolean) {
      const entry = entries.get(blockKey);
      if (!entry || entry.showOriginal === value) return;
      entry.showOriginal = value;
      // Broadcast repaint is safe: each read checks only its own entry's flag.
      // Preserve translated fragments for an immediate, request-free switch back.
      notify();
    },
    getShowOriginal: (blockKey: string) => entries.get(blockKey)?.showOriginal ?? false,
    dispose() {
      disposed = true;
      for (const entry of entries.values()) retire(entry);
      entries.clear();
      listeners.clear();
    },
  };
}
