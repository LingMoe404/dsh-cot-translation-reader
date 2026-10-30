import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { browserTranslationLocale } from '../src/client/locale.js';
import { createHttpTranslationClient } from '../src/client/index.js';

afterEach(() => vi.unstubAllGlobals());

test('UI locale takes priority over document and browser locale', () => {
  vi.stubGlobal('document', { documentElement: { lang: 'en' } });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  assert.equal(browserTranslationLocale('zh'), 'zh');
});

test('document language is used before browser language', () => {
  vi.stubGlobal('document', { documentElement: { lang: 'zh-cn' } });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  assert.equal(browserTranslationLocale(), 'zh-CN');
});

test('invalid language candidates and wildcard are skipped', () => {
  vi.stubGlobal('document', { documentElement: { lang: '*' } });
  vi.stubGlobal('navigator', { languages: ['*', 'auto', 'zh-CN'], language: 'en' });
  assert.equal(browserTranslationLocale('*'), 'zh-CN');
});

test('browser language is a final fallback and unavailable locale becomes en', () => {
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('navigator', { languages: [], language: 'ja' });
  assert.equal(browserTranslationLocale(), 'ja');
  vi.stubGlobal('navigator', undefined);
  assert.equal(browserTranslationLocale(), 'en');
});

test('HTTP client sends concrete locale with text even if automatic HTTP headers are wildcard', async () => {
  vi.stubGlobal('document', { documentElement: { lang: 'zh-CN' } });
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'Hello world', locale: 'zh-CN' });
    return new Response(JSON.stringify({ text: '你好，世界' }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = createHttpTranslationClient();
  assert.equal(await client.translate('Hello world', new AbortController().signal), '你好，世界');
  assert.equal(fetchMock.mock.calls.length, 1);
});

test('HTTP client reads fresh UI locale for every request', async () => {
  let locale = 'zh';
  const sent: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).locale);
    return new Response(JSON.stringify({ text: 'translated' }), { status: 200 });
  }));
  const client = createHttpTranslationClient(() => browserTranslationLocale(locale));
  await client.translate('one', new AbortController().signal);
  locale = 'ja';
  await client.translate('two', new AbortController().signal);
  assert.deepEqual(sent, ['zh', 'ja']);
});
