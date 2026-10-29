import type { Context } from '@deepseek-ai/cordis';
export declare const name = "cot-translation-reader";
/**
 * The reading view only paints translated reasoning when it offers the seam,
 * so wait for it instead of mounting without a place to contribute.
 */
export declare const inject: string[];
/**
 * Register a display-only reasoning transformer that reads the official COT
 * translation Remote. Nothing is sent until the reading view asks for text.
 *
 * @param ctx - browser plugin context.
 * @returns disposer that withdraws the transformer and aborts pending requests.
 */
export declare function apply(ctx: Context): () => void;
//# sourceMappingURL=index.d.ts.map