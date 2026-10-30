import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createReasoningTransformer, type DisplayTextRequest } from '../src/client/transformer.js';

/** No network or real UI: model broadcast notifications with batched rereads. */
test.each([40, 41, 45, 100, 512, 600])('%i mounted cards settle without eviction/retranslation feedback', async (count) => {
  const calls: string[] = [];
  let notifications = 0;
  let safetyCapHit = false;
  let repaintQueued = false;
  const requests: DisplayTextRequest[] = Array.from({ length: count }, (_, index) => ({
    text: `reasoning card ${index}`, streaming: false,
    blockKey: `mounted-${index}`, kind: 'reasoning', source: 'assistant',
  }));
  const admitted = Math.min(count, 512);
  const api = createReasoningTransformer({
    async limits() { return { maxTextChars: 40, targetLanguage: 'zh', provider: 'mock' }; },
    async translate(text) { calls.push(text); return text.toUpperCase(); },
  });
  const repaint = () => { for (const request of requests) api.transformer.read(request); };
  const unsubscribe = api.transformer.subscribe?.(() => {
    notifications += 1;
    // An old implementation can keep generating microtasks forever. Fail safely
    // rather than allowing a regression test to hang the runner or workstation.
    if (notifications > admitted + 6) {
      safetyCapHit = true;
      api.dispose();
      return;
    }
    if (repaintQueued) return;
    repaintQueued = true;
    queueMicrotask(() => { repaintQueued = false; repaint(); });
  });
  try {
    repaint();
    await vi.waitFor(() => {
      assert.equal(safetyCapHit, false, 'broadcast rereads must converge');
      assert.equal(calls.length, admitted);
      assert.equal(api.transformer.read(requests[admitted - 1]!)?.text, requests[admitted - 1]!.text.toUpperCase());
    }, { timeout: 3000, interval: 10 });
    assert.equal(new Set(calls).size, admitted, 'each admitted card is translated once');
    for (let sweep = 0; sweep < 5; sweep += 1) repaint();
    for (let index = admitted; index < count; index += 1) {
      assert.equal(api.transformer.read(requests[index]!), undefined, 'capacity fallback preserves source');
    }
    const selected = requests[0]!;
    api.setShowOriginal(selected.blockKey, true);
    assert.deepEqual(api.transformer.read(selected), { text: selected.text, final: true });
    for (const request of requests.slice(1, admitted)) {
      assert.equal(api.transformer.read(request)?.text, request.text.toUpperCase(), 'other cards keep their translations');
    }
    for (const request of requests.slice(admitted)) {
      api.setShowOriginal(request.blockKey, true);
      assert.equal(api.getShowOriginal(request.blockKey), false, 'nonadmitted cards cannot retain toggle state');
      assert.equal(api.transformer.read(request), undefined);
    }
    api.setShowOriginal(selected.blockKey, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(safetyCapHit, false);
    assert.equal(calls.length, admitted, 'repaints and source toggle never restart completed work');
    assert.equal(api.transformer.read(requests[0]!)?.text, requests[0]!.text.toUpperCase());
  } finally {
    unsubscribe?.();
    api.dispose();
  }
});
