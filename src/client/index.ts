import type { Context } from '@deepseek-ai/cordis';
import {
  createReasoningTransformer,
  type DisplayTextTransformer,
  type TranslationClient,
} from './transformer.js';
import { installOriginalToggle } from './toggle.js';

/** Reading view seam, documented in dsh-better-display's `docs/extension-points.md`. */
const SEAM_SERVICE = 'dsh-better-display.text-transform';
/** Same-origin Host routes registered by `src/index.ts`. */
const ROUTE_LIMITS = '/cot-translation-reader/limits';
const ROUTE_TRANSLATE = '/cot-translation-reader/translate';

interface TextTransformSeam {
  register(kind: 'reasoning', transformer: DisplayTextTransformer): () => void;
}

/** Every service lookup is optional: this plugin must not break a host without them. */
function lookup<T>(ctx: Context, service: string): T | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  return get.call(ctx, service) as T | undefined;
}

/**
 * Browser side of the translation routes.
 *
 * The official bundle's `cotTranslation` service lives on the Host, so the
 * browser asks the Host half instead of reaching for that name directly.
 *
 * @returns client used by the transformer.
 */
export function createHttpTranslationClient(): TranslationClient {
  return {
    async limits(signal) {
      const response = await fetch(ROUTE_LIMITS, { signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`limits ${response.status}`);
      const body = await response.json() as { maxTextChars: number; provider: string; targetLanguage: string };
      if (typeof body.maxTextChars !== 'number') throw new Error('limits payload');
      return { maxTextChars: body.maxTextChars, provider: body.provider, targetLanguage: body.targetLanguage };
    },
    async translate(text, signal) {
      const response = await fetch(ROUTE_TRANSLATE, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`translate ${response.status}`);
      const body = await response.json() as { text?: unknown };
      if (typeof body.text !== 'string') throw new Error('translate payload');
      return body.text;
    },
  };
}

export const name = 'cot-translation-reader';

/**
 * The reading view only paints translated reasoning when it offers the seam,
 * so wait for it instead of mounting without a place to contribute.
 */
export const inject = [SEAM_SERVICE];

/**
 * Register a display-only reasoning transformer backed by the Host routes.
 *
 * @param ctx - browser plugin context.
 * @returns disposer that withdraws the transformer and aborts pending requests.
 */
export function apply(ctx: Context): () => void {
  const seam = lookup<TextTransformSeam>(ctx, SEAM_SERVICE);
  if (!seam) return () => {};
  const { transformer, dispose, getShowOriginal, setShowOriginal } = createReasoningTransformer(
    createHttpTranslationClient(),
    error => {
      console.warn('[cot-translation-reader] reasoning translation failed; keeping the source text', error);
    },
  );
  const removeToggle = installOriginalToggle({ getShowOriginal, setShowOriginal });
  const unregister = seam.register('reasoning', transformer);
  return () => {
    unregister();
    removeToggle();
    dispose();
  };
}
