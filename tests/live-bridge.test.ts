import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createReasoningTransformer, type TranslationClient } from '../src/client/transformer.js';

/** Opt-in only: this sends synthetic fixture text to the configured provider. */
test.skipIf(!process.env.READER_TEST_URL)('live bridge translates reasoning and preserves the original toggle', async () => {
  const base = `${process.env.READER_TEST_URL}/cot-translation-reader`;
  const client: TranslationClient = {
    async limits(signal) {
      const response = await fetch(`${base}/limits`, { signal });
      assert.equal(response.status, 200);
      return response.json();
    },
    async translate(text, signal) {
      const response = await fetch(`${base}/translate`, {
        signal, method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': '*' },
        body: JSON.stringify({ text, locale: 'zh-CN' }),
      });
      assert.equal(response.status, 200);
      return ((await response.json()) as { text: string }).text;
    },
  };
  const request = {
    text: 'The reading view should display translated reasoning automatically.\n\nThe original text must remain available.',
    streaming: false, blockKey: 'synthetic-live-test', kind: 'reasoning' as const, source: 'assistant' as const,
  };
  const errors: unknown[] = [];
  const api = createReasoningTransformer(client, error => errors.push(error));
  const unsubscribe = api.transformer.subscribe?.(() => { queueMicrotask(() => api.transformer.read(request)); });
  try {
    api.transformer.read(request);
    await vi.waitFor(() => {
      const shown = api.transformer.read(request);
      assert.ok(shown);
      assert.match(shown.text, /\p{Script=Han}/u);
      assert.ok(!shown.text.includes('The original text must remain available.'));
      assert.equal(shown.final, true);
    }, { timeout: 90000, interval: 100 });
    const translated = api.transformer.read(request)?.text;
    api.setShowOriginal(request.blockKey, true);
    assert.equal(api.getShowOriginal(request.blockKey), true);
    assert.deepEqual(api.transformer.read(request), { text: request.text, final: true });
    api.setShowOriginal(request.blockKey, false);
    assert.equal(api.transformer.read(request)?.text, translated);
    assert.deepEqual(errors, []);
  } finally {
    unsubscribe?.();
    api.dispose();
  }
}, 100000);
