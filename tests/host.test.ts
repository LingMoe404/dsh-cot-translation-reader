import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';

test('HTTP bridge negotiates concrete target tags without forwarding wildcards', async () => {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  let preference = 'auto';
  const resolved: { targetLanguage: string; provider?: string }[] = [];
  const translator = {
    resolve(spec: { targetLanguage: string; provider?: string }) { resolved.push(spec); return spec; },
    async translate() { return 'translated'; },
  };
  const ctx = {
    webServer: {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
        routes.set(route.path, route.handler);
        return () => { routes.delete(route.path); };
      },
    },
    get(name: string) {
      if (name === 'translator') return translator;
      if (name === 'cotTranslation') return {
        async limits() { return { maxTextChars: 4000, preferences: { provider: 'bing', targetLanguage: preference } }; },
      };
    },
  };
  const dispose = apply(ctx as unknown as Context);
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '');
    if (!handler) { res.writeHead(404).end(); return; }
    void Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/cot-translation-reader`;
  const cases = [
    { header: '*', locale: 'zh-CN', expected: 'zh-CN' },
    { header: '*', expected: 'en' },
    { header: '* , zh-CN;q=.9', expected: 'zh-CN' },
    { header: 'fr;q=.2,zh-cn;q=.9,en;q=.5', expected: 'zh-CN' },
    { header: 'fr;q=0,zh-CN;q=.8', expected: 'zh-CN' },
    { header: 'fr;q=0,*;q=1', expected: 'en' },
    { header: 'fr;q=.9,zh-CN;q=.9', expected: 'fr' },
    { header: 'fr;q=2,de;q=oops,auto,en_US,zh-CN;q=.8', expected: 'zh-CN' },
    { header: '*', locale: '*', expected: 'en' },
    { header: 'zh-CN', locale: 'auto', expected: 'zh-CN' },
    { header: 'zh-CN', locale: { tag: 'de' }, expected: 'zh-CN' },
    { header: 'fr', locale: 'en_US', expected: 'fr' },
    { header: 'fr', locale: 'zh-cn', expected: 'zh-CN' },
    { header: '*', locale: 'zh-CN', preference: 'ja', expected: 'ja' },
    { header: 'fr', locale: 'zh-CN', preference: 'EN-us', expected: 'en-US' },
    { header: '*', locale: 'zh-CN', preference: '*', expected: 'zh-CN' },
    { header: 'x'.repeat(8193), expected: 'en' },
  ];
  try {
    for (const item of cases) {
      preference = item.preference ?? 'auto';
      const response = await fetch(`${base}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': item.header },
        body: JSON.stringify({ text: 'private text', locale: item.locale }),
      });
      assert.equal(response.status, 200, JSON.stringify(item));
      await response.json();
      assert.equal(resolved.at(-1)?.targetLanguage, item.expected, JSON.stringify(item));
      assert.equal(resolved.at(-1)?.provider, 'bing');
      const status = await (await fetch(`${base}/status`)).json();
      assert.equal(status.lastRequest.targetLanguage, item.expected);
      assert.equal(status.failed, 0);
    }
  } finally {
    dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('HTTP bridge resolves browser locale and clears historical errors after recovery', async () => {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
  let fail = true;
  const resolved: unknown[] = [];
  const translator = {
    resolve(spec: unknown) { resolved.push(spec); return spec; },
    async translate() {
      if (fail) throw Object.assign(new Error('bing translation failed (HTTP 400)'), { code: 'TRANSLATION_HTTP_ERROR' });
      return '你好，世界';
    },
  };
  const ctx = {
    webServer: {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
        routes.set(route.path, route.handler);
        return () => { routes.delete(route.path); };
      },
    },
    get(name: string) {
      if (name === 'translator') return translator;
      if (name === 'cotTranslation') return {
        async limits() { return { maxTextChars: 4000, preferences: { provider: 'bing', targetLanguage: 'auto' } }; },
      };
    },
  };
  const dispose = apply(ctx as unknown as Context);
  const server = createServer((req, res) => {
    const handler = routes.get(req.url ?? '');
    if (!handler) { res.writeHead(404).end(); return; }
    void Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500).end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/cot-translation-reader`;
  const status = async () => (await fetch(`${base}/status`)).json();
  const text = 'private reasoning with real\n\nparagraphs';
  const translate = () => fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN,zh;q=0.9' },
    body: JSON.stringify({ text }),
  });
  try {
    assert.equal((await fetch(`${base}/limits`)).status, 200);
    assert.equal((await translate()).status, 502);
    const failed = await status();
    assert.equal(failed.attempts, 1);
    assert.equal(failed.failed, 1);
    assert.equal(failed.pending, 0);
    assert.equal(failed.lastOutcome, 'failure');
    assert.match(failed.lastError, /HTTP 400/);
    assert.deepEqual(failed.lastRequest, { textChars: text.length, targetLanguage: 'zh-CN', provider: 'bing' });
    assert.ok(!JSON.stringify(failed).includes(text));
    fail = false;
    const response = await translate();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: '你好，世界' });
    const success = await status();
    assert.equal(success.translate, 1);
    assert.equal(success.attempts, 2);
    assert.equal(success.failed, 1);
    assert.equal(success.pending, 0);
    assert.equal(success.lastOutcome, 'success');
    assert.equal(success.lastError, '');
    assert.deepEqual(resolved[0], { text, targetLanguage: 'zh-CN', provider: 'bing' });
  } finally {
    dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
