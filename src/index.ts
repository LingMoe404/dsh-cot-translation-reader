import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { concreteLanguageTag } from './language.js';

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

/** Diagnostics deliberately exclude reasoning text and request headers. */
interface RequestMetadata {
  textChars: number;
  targetLanguage: string;
  provider?: string;
}


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

/** Resolve preferences, browser locale, then weighted concrete header tags. */
function targetLanguageOf(req: IncomingMessage, requested: string, locale: unknown): string {
  const explicit = concreteLanguageTag(requested);
  if (explicit) return explicit;
  const browser = concreteLanguageTag(locale);
  if (browser) return browser;
  const header = req.headers['accept-language'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  // Bound parsing work as well as individual tags; never forward opaque input.
  if (!raw || raw.length > 8192) return 'en';
  let best: string | undefined;
  let bestQuality = 0;
  for (const entry of raw.split(',')) {
    const [range, ...parameters] = entry.split(';');
    const tag = concreteLanguageTag(range);
    if (!tag) continue;
    let quality = 1;
    if (parameters.length > 0) {
      if (parameters.length !== 1) continue;
      // Accept common fractional q=.9 as well as standard q=0.9 notation.
      const match = /^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?|\.\d{1,3})$/i.exec(parameters[0]!.trim());
      if (!match) continue;
      quality = Number(match[1]);
    }
    if (quality > bestQuality) {
      best = tag;
      bestQuality = quality;
    }
  }
  return best ?? 'en';
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
  const calls = {
    limits: 0, translate: 0, attempts: 0, failed: 0, pending: 0,
    lastError: '',
    lastRequest: undefined as RequestMetadata | undefined,
    lastOutcome: 'idle' as 'idle' | 'success' | 'failure',
  };
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
      let locale: unknown;
      try {
        const parsed: unknown = JSON.parse(await readBody(req));
        if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
          text = (parsed as { text: string }).text;
          locale = (parsed as { locale?: unknown }).locale;
        }
      } catch {
        sendJson(res, 400, { error: 'bad-request' });
        return;
      }
      if (text.trim() === '') {
        sendJson(res, 400, { error: 'empty-text' });
        return;
      }
      calls.attempts += 1;
      calls.pending += 1;
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
        const targetLanguage = targetLanguageOf(req, requested, locale);
        calls.lastRequest = { textChars: text.length, targetLanguage, provider };
        // Prefer the translator: cotTranslation rewrites every failure into one
        // opaque message, which leaves nothing to diagnose.
        const translated = direct
          ? await direct.translate(direct.resolve({ text, targetLanguage, provider }), new AbortController().signal)
          : await current!.translate({ text, targetLanguage, provider }, new AbortController().signal);
        calls.translate += 1;
        calls.lastError = '';
        calls.lastOutcome = 'success';
        sendJson(res, 200, { text: translated });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = error instanceof Error ? error.message : String(error);
        calls.failed += 1;
        calls.lastOutcome = 'failure';
        calls.lastError = typeof code === 'string' ? `${code}: ${message}` : message;
        sendJson(res, 502, { error: 'translate-failed' });
      } finally {
        calls.pending -= 1;
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
