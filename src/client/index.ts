import type { Context } from '@deepseek-ai/cordis';
import {
  createReasoningTransformer,
  type CotTranslationService,
  type DisplayTextTransformer,
} from './transformer.js';

/** Reading view seam, documented in dsh-better-display's `docs/extension-points.md`. */
const SEAM_SERVICE = 'dsh-better-display.text-transform';
/** Official COT translation Remote; looked up lazily so either bundle can be disabled. */
const COT_SERVICE = 'cotTranslation';

interface TextTransformSeam {
  register(kind: 'reasoning', transformer: DisplayTextTransformer): () => void;
}

/** Every service lookup is optional: this plugin must not break a host without them. */
function lookup<T>(ctx: Context, service: string): T | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return get.call(ctx, service) as T | undefined;
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
export function apply(ctx: Context): () => void {
  const seam = lookup<TextTransformSeam>(ctx, SEAM_SERVICE);
  if (!seam) return () => {};
  const { transformer, dispose } = createReasoningTransformer(
    () => lookup<CotTranslationService>(ctx, COT_SERVICE),
    error => {
      console.warn('[cot-translation-reader] reasoning translation failed; keeping the source text', error);
    },
  );
  const unregister = seam.register('reasoning', transformer);
  return () => {
    unregister();
    dispose();
  };
}
