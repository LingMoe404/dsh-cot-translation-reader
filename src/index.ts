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

export const name = 'cot-translation-reader';

/** Routes exist only while the Host is mounted, so wait for the web server. */
export const inject = ['webServer'];

const ROUTE_LIMITS = '/cot-translation-reader/limits';
const ROUTE_TRANSLATE = '/cot-translation-reader/translate';
const MAX_BODY_BYTES = 64 * 1024;

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
 * Register the translation routes.
 *
 * @param ctx - Host plugin context.
 * @returns disposer removing both routes.
 */
export function apply(ctx: Context): () => void {
  const server = ctx.webServer;
  if (!server) return () => {};
  const service = (): CotTranslation | undefined =>
    (ctx as unknown as { get?: (name: string) => unknown }).get?.call(ctx, 'cotTranslation') as CotTranslation | undefined;

  const disposeLimits = server.register({
    kind: 'exact',
    path: ROUTE_LIMITS,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const current = service();
      if (!current) {
        sendJson(res, 503, { error: 'cot-translation-unavailable' });
        return;
      }
      try {
        const snapshot = await current.limits(new AbortController().signal);
        sendJson(res, 200, {
          maxTextChars: snapshot.maxTextChars,
          provider: snapshot.preferences.provider,
          targetLanguage: snapshot.preferences.targetLanguage,
        });
      } catch {
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
      if (!current) {
        sendJson(res, 503, { error: 'cot-translation-unavailable' });
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
        const snapshot = await current.limits(new AbortController().signal);
        const translated = await current.translate(
          {
            text,
            targetLanguage: snapshot.preferences.targetLanguage,
            provider: snapshot.preferences.provider,
          },
          new AbortController().signal,
        );
        sendJson(res, 200, { text: translated });
      } catch {
        sendJson(res, 502, { error: 'translate-failed' });
      }
    },
  });

  return () => {
    disposeLimits();
    disposeTranslate();
  };
}
