import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the built browser factory with synthetic data only. No live DOM,
// HTTP, profile, or desktop interaction is permitted in this check.
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
for (const count of [40, 41, 45, 100, 512, 600]) {
  let client;
  let transformer;
  let registrations = 0;
  const calls = [];
  const warnings = [];
  let inFlight = 0;
  let maxInFlight = 0;
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(spec) {
      assert.equal(spec.id, 'dsh-cot-translation-reader');
      registrations += 1;
      client = spec.factory(name => { throw new Error(`Unexpected runtime dependency: ${name}`); });
    } } },
    AbortController, queueMicrotask, setTimeout, clearTimeout,
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
    navigator: { languages: ['en-US'], language: 'en-US' },
    async fetch(url, init) {
      assert.ok(!init?.signal?.aborted);
      if (url === '/cot-translation-reader/limits') {
        return { ok: true, async json() { return { maxTextChars: 4000, targetLanguage: 'auto', provider: 'mock' }; } };
      }
      assert.equal(url, '/cot-translation-reader/translate');
      const body = JSON.parse(init.body);
      assert.equal(body.locale, 'zh', 'built client must use UI locale, not an automatic wildcard header');
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(body.text);
      await Promise.resolve();
      inFlight -= 1;
      return { ok: true, async json() { return { text: body.text.toUpperCase() }; } };
    },
  }, { timeout: 2000, filename: 'lib/client.js' });
  assert.equal(registrations, 1);
  const dispose = client.apply({ get(name) {
    if (name === 'locale') return { getSnapshot: () => ({ active: 'zh' }) };
    if (name === 'dsh-better-display.text-transform') return { register(kind, value) {
      assert.equal(kind, 'reasoning');
      transformer = value;
      return () => {};
    } };
  } });
  assert.ok(transformer);
  const requests = Array.from({ length: count }, (_, index) => ({
    text: `synthetic reasoning ${index}`, blockKey: `built-${index}`,
    streaming: false, kind: 'reasoning', source: 'assistant',
  }));
  const expected = Math.min(count, 512);
  let notifications = 0;
  let repaintQueued = false;
  let capped = false;
  const repaint = () => { for (const request of requests) transformer.read(request); };
  const unsubscribe = transformer.subscribe(() => {
    if (++notifications > expected + 6) { capped = true; dispose(); return; }
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => { repaintQueued = false; repaint(); });
  });
  try {
    repaint();
    // The notification bound stops a feedback regression before this timer;
    // a successful microtask batch must settle rather than starve it forever.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(capped, false, 'built client notification feedback did not settle');
    assert.equal(calls.length, expected);
    assert.equal(new Set(calls).size, expected);
    for (let sweep = 0; sweep < 5; sweep += 1) repaint();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, expected, 'built client rerequested cached translations');
    assert.equal(transformer.read(requests[0]).text, requests[0].text.toUpperCase());
    for (let index = expected; index < count; index += 1) assert.equal(transformer.read(requests[index]), undefined);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(warnings, []);
    console.log(`PASS built browser: ${count} cards, ${calls.length} requests, ${notifications} notifications, serial, settled`);
  } finally {
    unsubscribe();
    dispose();
  }
}
