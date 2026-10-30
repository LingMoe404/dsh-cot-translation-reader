import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';

/**
 * Host half. The official COT bundle provides `cotTranslation` on the Host
 * only — its browser half never exposes that name, so the reading view cannot
 * reach it directly. This half registers two same-origin routes the browser
 * half calls instead: one reads routing without sending text, one translates.
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer?: {
      register: (route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
      }) => () => void;
    };
  }
}

/** Structural face of the Host-side `cotTranslation` service. */
interface CotTranslation {
  limits(signal: AbortSignal): Promise<{
    maxTextChars: number;
    preferences: { provider: string; targetLanguage: string };
  }>;
  translate(
    request: { text: string; targetLanguage: string; provider?: string },
    signal: AbortSignal,
  ): Promise<string>;
}

/**
 * Structural face of the Host-side `translator` service.
 *
 * `cotTranslation` wraps every failure into one opaque message, so the route
 * calls the translator directly and keeps the real error code.
 */
interface Translator {
  readonly maxTextChars?: number;
  resolve(request: { text: string; targetLanguage: string; provider?: string }): unknown;
  translate(spec: unknown, signal?: AbortSignal): Promise<string>;
}

export const name = 'cot-translation-reader';

/** Routes exist only while the Host is mounted, so wait for the web server. */
export const inject = ['webServer'];

const ROUTE_LIMITS = '/cot-translation-reader/limits';
const ROUTE_TRANSLATE = '/cot-translation-reader/translate';
const ROUTE_STATUS = '/cot-translation-reader/status';
const MAX_BODY_BYTES = 64 * 1024;

/** Call counters, so a restart can be checked from outside the browser. */
const calls = { limits: 0, translate: 0, lastError: '' as string };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve `auto` to a concrete tag.
 *
 * The official browser half resolves `auto` from the UI locale before it calls
 * the Host; this route has no UI locale, so it uses the request's
 * `Accept-Language`. Providers reject `to=auto` outright (Bing answers 400),
 * so leaving it unresolved would fail every request.
 */
function targetLanguageOf(req: IncomingMessage, requested: string): string {
  if (requested !== 'auto') return requested;
  const header = req.headers['accept-language'];
  const raw = Array.isArray(header) ? header[0] : header;
  const first = raw?.split(',')[0]?.split(';')[0]?.trim();
  return first && first.length > 0 ? first : 'en';
}

/**
 * Register the translation routes.
 *
 * @param ctx - Host plugin context.
 * @returns disposer removing both routes.
 */
export function apply(ctx: Context): () => void {
  const server = ctx.webServer;
  if (!server) return () => {};
  const lookup = <T>(name: string): T | undefined =>
    (ctx as unknown as { get?: (key: string) => unknown }).get?.call(ctx, name) as T | undefined;
  const service = (): CotTranslation | undefined => lookup<CotTranslation>('cotTranslation');
  const translator = (): Translator | undefined => lookup<Translator>('translator');
  const available = () => translator() !== undefined || service() !== undefined;

  const disposeLimits = server.register({
    kind: 'exact',
    path: ROUTE_LIMITS,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      calls.limits += 1;
      const current = service();
      if (!current) {
        // Preferences belong to the official bundle; without it, fall back to
        // the translator's own limit and default routing.
        const t = translator();
        if (!t) {
          calls.lastError = 'translation-unavailable';
          sendJson(res, 503, { error: 'translation-unavailable' });
          return;
        }
        sendJson(res, 200, {
          maxTextChars: t.maxTextChars ?? 4000,
          provider: 'bing',
          targetLanguage: 'auto',
        });
        return;
      }
      try {
        const snapshot = await current.limits(new AbortController().signal);
        sendJson(res, 200, {
          maxTextChars: snapshot.maxTextChars,
          provider: snapshot.preferences.provider,
          targetLanguage: snapshot.preferences.targetLanguage,
        });
      } catch (error) {
        calls.lastError = error instanceof Error ? error.message : String(error);
        sendJson(res, 502, { error: 'limits-failed' });
      }
    },
  });

  const disposeTranslate = server.register({
    kind: 'exact',
    path: ROUTE_TRANSLATE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const current = service();
      const direct = translator();
      if (!current && !direct) {
        calls.lastError = 'translation-unavailable';
        sendJson(res, 503, { error: 'translation-unavailable' });
        return;
      }
      let text = '';
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
          text = (parsed as { text: string }).text;
        }
      } catch {
        sendJson(res, 400, { error: 'bad-request' });
        return;
      }
      if (text.trim() === '') {
        sendJson(res, 400, { error: 'empty-text' });
        return;
      }
      try {
        // Preferences live in the official bundle's settings, so read them per
        // request instead of caching a copy that can drift.
        let requested = 'auto';
        let provider: string | undefined;
        if (current) {
          const snapshot = await current.limits(new AbortController().signal);
          requested = snapshot.preferences.targetLanguage;
          provider = snapshot.preferences.provider;
        }
        const targetLanguage = targetLanguageOf(req, requested);
        // Prefer the translator: cotTranslation rewrites every failure into one
        // opaque message, which leaves nothing to diagnose.
        const translated = direct
          ? await direct.translate(direct.resolve({ text, targetLanguage, provider }), new AbortController().signal)
          : await current!.translate({ text, targetLanguage, provider }, new AbortController().signal);
        calls.translate += 1;
        sendJson(res, 200, { text: translated });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : String(error);
        calls.lastError = typeof code === 'string' ? `${code}: ${message}` : message;
        sendJson(res, 502, { error: 'translate-failed' });
      }
    },
  });

  const disposeStatus = server.register({
    kind: 'exact',
    path: ROUTE_STATUS,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      sendJson(res, 200, { ...calls, available: available() });
    },
  });

  return () => {
    disposeLimits();
    disposeTranslate();
    disposeStatus();
  };
}
