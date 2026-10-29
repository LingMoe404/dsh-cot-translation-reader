/**
 * Display-only translation of reasoning for dsh-better-display's reading view.
 *
 * The reading view exposes `dsh-better-display.text-transform`; a registrant
 * returns the string it wants painted and never touches the session, the
 * transcript, or the fold. Translation therefore lives here, not in that
 * plugin: this module reads the official COT translation Remote and hands the
 * reading view a translated string plus a subscription that says when a later
 * batch changed it.
 */

/** Kinds the reading view offers; only reasoning is translated here. */
export type DisplayTextKind = 'reasoning' | 'body'

/** One mounted block, as the reading view describes it. */
export interface DisplayTextRequest {
  readonly text: string
  readonly streaming: boolean
  readonly blockKey: string
  readonly kind: DisplayTextKind
  readonly source?: 'assistant' | 'user' | 'tool'
}

/** What the reading view paints instead of the source string. */
export interface DisplayText {
  readonly text: string
  /** `false` keeps the live reveal open; `true` settles it. */
  readonly final: boolean
}

/** Seam contract from `docs/extension-points.md`. */
export interface DisplayTextTransformer {
  read(request: DisplayTextRequest): DisplayText | undefined
  subscribe?(listener: () => void): () => void
}

/** Routing the Host accepted before any text is sent. */
export interface TranslationTarget {
  readonly maxTextChars: number
  readonly provider: string
  readonly targetLanguage: string
}

/** Structural face of `ctx.cotTranslation` (`@deepseek-ai/dsh-experimental-client-ui-cot-translation`). */
export interface CotTranslationService {
  limits(signal: AbortSignal): Promise<{
    readonly maxTextChars: number
    readonly preferences: { readonly provider: string; readonly targetLanguage: string }
  }>
  translate(
    request: { readonly text: string; readonly targetLanguage: string; readonly provider?: string },
    signal: AbortSignal,
  ): Promise<string>
}

/** One translated slice of the source. */
export interface ReasoningFragment {
  /** Text submitted for translation; replaced by the result. */
  readonly body: string
  /** Whitespace after the body, kept verbatim. */
  readonly suffix: string
}

/** Blank-line paragraph breaks, retaining their exact characters. */
const PARAGRAPH_BREAK = /\n[ \t]*\n[ \t]*/g

/** Mounted blocks retained before the oldest is dropped. */
const MAX_BLOCKS = 40

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
  fragments: ReasoningFragment[]
  tail: string
} {
  const limit = Math.max(2, Math.floor(maxTextChars) || 2)
  const fragments: ReasoningFragment[] = []
  if (!text) return { fragments, tail: '' }

  const segments: Array<{ body: string; separator: string }> = []
  let start = 0
  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    const index = match.index ?? 0
    segments.push({ body: text.slice(start, index), separator: match[0] })
    start = index + match[0].length
  }
  segments.push({ body: text.slice(start), separator: '' })

  let tail = ''
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const last = index === segments.length - 1
    if (last && running) {
      tail = segment.body + segment.separator
      break
    }
    if (segment.body.trim() === '') {
      const previous = fragments.at(-1)
      if (previous) fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.body + segment.separator }
      else fragments.push({ body: '', suffix: segment.body + segment.separator })
      continue
    }
    let body = segment.body
    while (body.length > limit) {
      let cut = body.lastIndexOf(' ', limit)
      if (cut < Math.floor(limit / 2)) cut = body.lastIndexOf('\n', limit)
      if (cut < Math.floor(limit / 2)) cut = limit
      fragments.push({ body: body.slice(0, cut), suffix: '' })
      body = body.slice(cut)
    }
    if (body !== '') fragments.push({ body, suffix: segment.separator })
    else if (fragments.length > 0) {
      const previous = fragments[fragments.length - 1]
      fragments[fragments.length - 1] = { body: previous.body, suffix: previous.suffix + segment.separator }
    }
  }
  return { fragments, tail }
}

interface Entry {
  source: string
  streaming: boolean
  fragments: ReasoningFragment[]
  tail: string
  readonly results: Map<string, string>
  rendered?: string
  pending: boolean
  scheduled: boolean
  dirty: boolean
  controller?: AbortController
}

/** Build the transformer the reading view registers, plus a disposer. */
export function createReasoningTransformer(
  service: () => CotTranslationService | undefined,
  onError: (error: unknown) => void = () => {},
): { transformer: DisplayTextTransformer; dispose: () => void } {
  const entries = new Map<string, Entry>()
  const listeners = new Set<() => void>()
  let disposed = false
  let target: TranslationTarget | undefined
  let preparing: Promise<void> | undefined

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        onError(error)
      }
    }
  }

  const prepare = (api: CotTranslationService) => {
    if (target || preparing) return
    preparing = api.limits(new AbortController().signal).then((snapshot) => {
      target = {
        maxTextChars: snapshot.maxTextChars,
        provider: snapshot.preferences.provider,
        targetLanguage: snapshot.preferences.targetLanguage,
      }
      // Limits change nothing on their own, but every mounted block can now be
      // split, so let the reading view ask again.
      notify()
    }).catch((error: unknown) => {
      if (!disposed) onError(error)
    }).finally(() => {
      preparing = undefined
    })
  }

  const assemble = (entry: Entry): string => {
    let text = ''
    for (const fragment of entry.fragments) {
      text += (entry.results.get(fragment.body) ?? fragment.body) + fragment.suffix
    }
    return text + entry.tail
  }

  const run = async (entry: Entry, api: CotTranslationService): Promise<void> => {
    if (disposed || entry.pending) return
    const current = target
    if (!current) return
    entry.pending = true
    const controller = new AbortController()
    entry.controller = controller
    try {
      for (let index = 0; index < entry.fragments.length; index += 1) {
        const fragment = entry.fragments[index]
        if (entry.results.has(fragment.body) || fragment.body.trim() === '') continue
        const translated = await api.translate(
          { text: fragment.body, targetLanguage: current.targetLanguage, provider: current.provider },
          controller.signal,
        )
        if (disposed || controller.signal.aborted) return
        entry.results.set(fragment.body, translated)
        entry.rendered = assemble(entry)
        notify()
      }
    } catch (error) {
      // Keep the source text on screen; the next paint can try again.
      if (!disposed && !controller.signal.aborted) onError(error)
    } finally {
      entry.pending = false
      entry.controller = undefined
      if (!disposed && entry.dirty) schedule(entry, api)
    }
  }

  const schedule = (entry: Entry, api: CotTranslationService) => {
    if (disposed || entry.pending || entry.scheduled) return
    entry.scheduled = true
    queueMicrotask(() => {
      entry.scheduled = false
      if (!disposed) void run(entry, api)
    })
  }

  const ensure = (blockKey: string): Entry => {
    const existing = entries.get(blockKey)
    if (existing) return existing
    const entry: Entry = { source: '', streaming: false, fragments: [], tail: '', results: new Map(), pending: false, scheduled: false, dirty: false }
    entries.set(blockKey, entry)
    if (entries.size > MAX_BLOCKS) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined && oldest !== blockKey) {
        entries.get(oldest)?.controller?.abort()
        entries.delete(oldest)
      }
    }
    return entry
  }

  const transformer: DisplayTextTransformer = {
    read(request) {
      if (disposed || request.kind !== 'reasoning' || request.source === 'tool') return undefined
      const api = service()
      if (!api) return undefined
      const entry = ensure(request.blockKey)
      if (entry.source !== request.text || entry.streaming !== request.streaming) {
        entry.source = request.text
        entry.streaming = request.streaming
        entry.dirty = true
      }
      prepare(api)
      const current = target
      if (!current) return entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming }
      if (entry.dirty) {
        entry.dirty = false
        const next = reasoningFragments(entry.source, request.streaming, current.maxTextChars)
        entry.fragments = next.fragments
        entry.tail = next.tail
        // Until one fragment is translated, painting the source back would be a
        // no-op replacement; return undefined so the reading view keeps its own.
        entry.rendered = entry.results.size > 0 ? assemble(entry) : undefined
        schedule(entry, api)
      }
      return entry.rendered === undefined ? undefined : { text: entry.rendered, final: !request.streaming }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  return {
    transformer,
    dispose() {
      disposed = true
      for (const entry of entries.values()) entry.controller?.abort()
      entries.clear()
      listeners.clear()
    },
  }
}
