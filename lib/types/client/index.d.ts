import type { Context } from '@deepseek-ai/cordis';
import { type TranslationClient } from './transformer.js';
/**
 * Browser side of the translation routes.
 *
 * The official bundle's `cotTranslation` service lives on the Host, so the
 * browser asks the Host half instead of reaching for that name directly.
 *
 * @returns client used by the transformer.
 */
export declare function createHttpTranslationClient(): TranslationClient;
export declare const name = "cot-translation-reader";
/**
 * The reading view only paints translated reasoning when it offers the seam,
 * so wait for it instead of mounting without a place to contribute.
 */
export declare const inject: string[];
/**
 * Register a display-only reasoning transformer backed by the Host routes.
 *
 * @param ctx - browser plugin context.
 * @returns disposer that withdraws the transformer and aborts pending requests.
 */
export declare function apply(ctx: Context): () => void;
//# sourceMappingURL=index.d.ts.map