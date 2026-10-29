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
/** Seam contract from `docs/extension-points.md`. */
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
/** Structural face of `ctx.cotTranslation` (`@deepseek-ai/dsh-experimental-client-ui-cot-translation`). */
export interface CotTranslationService {
    limits(signal: AbortSignal): Promise<{
        readonly maxTextChars: number;
        readonly preferences: {
            readonly provider: string;
            readonly targetLanguage: string;
        };
    }>;
    translate(request: {
        readonly text: string;
        readonly targetLanguage: string;
        readonly provider?: string;
    }, signal: AbortSignal): Promise<string>;
}
/** One translated slice of the source. */
export interface ReasoningFragment {
    /** Text submitted for translation; replaced by the result. */
    readonly body: string;
    /** Whitespace after the body, kept verbatim. */
    readonly suffix: string;
}
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
export declare function reasoningFragments(text: string, running: boolean, maxTextChars: number): {
    fragments: ReasoningFragment[];
    tail: string;
};
/** Build the transformer the reading view registers, plus a disposer. */
export declare function createReasoningTransformer(service: () => CotTranslationService | undefined, onError?: (error: unknown) => void): {
    transformer: DisplayTextTransformer;
    dispose: () => void;
};
//# sourceMappingURL=transformer.d.ts.map