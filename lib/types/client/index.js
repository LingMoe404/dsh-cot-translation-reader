import { createReasoningTransformer, } from './transformer.js';
/** Reading view seam, documented in dsh-better-display's `docs/extension-points.md`. */
const SEAM_SERVICE = 'dsh-better-display.text-transform';
/** Official COT translation Remote; looked up lazily so either bundle can be disabled. */
const COT_SERVICE = 'cotTranslation';
/** Every service lookup is optional: this plugin must not break a host without them. */
function lookup(ctx, service) {
    const get = ctx.get;
    if (typeof get !== 'function')
        return undefined;
    return get.call(ctx, service);
}
export const name = 'cot-translation-reader';
/**
 * The reading view only paints translated reasoning when it offers the seam,
 * so wait for it instead of mounting without a place to contribute.
 */
export const inject = [SEAM_SERVICE];
/**
 * Register a display-only reasoning transformer that reads the official COT
 * translation Remote. Nothing is sent until the reading view asks for text.
 *
 * @param ctx - browser plugin context.
 * @returns disposer that withdraws the transformer and aborts pending requests.
 */
export function apply(ctx) {
    const seam = lookup(ctx, SEAM_SERVICE);
    if (!seam)
        return () => { };
    const { transformer, dispose } = createReasoningTransformer(() => lookup(ctx, COT_SERVICE), error => {
        console.warn('[cot-translation-reader] reasoning translation failed; keeping the source text', error);
    });
    const unregister = seam.register('reasoning', transformer);
    return () => {
        unregister();
        dispose();
    };
}
//# sourceMappingURL=index.js.map