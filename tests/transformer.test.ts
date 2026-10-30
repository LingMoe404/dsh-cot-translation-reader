import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  createReasoningTransformer,
  reasoningFragments,
  type TranslationClient,
} from '../src/client/transformer.js';

/** Drain microtasks and timers so the transformer can finish a batch. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
}

interface Recorder {
  client: TranslationClient;
  calls: string[];
  limitCalls: number;
  failTranslate: boolean;
  failLimits: boolean;
}

function recorder(): Recorder {
  const state: Recorder = {
    calls: [],
    limitCalls: 0,
    failTranslate: false,
    failLimits: false,
    client: {
      limits: async () => {
        state.limitCalls += 1;
        if (state.failLimits) throw new Error('503');
        return { maxTextChars: 40, provider: 'bing', targetLanguage: 'zh' };
      },
      translate: async (text) => {
        state.calls.push(text);
        if (state.failTranslate) throw new Error('offline');
        return text.toUpperCase();
      },
    },
  };
  return state;
}

const request = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  streaming: false,
  blockKey: 'block-1',
  kind: 'reasoning' as const,
  source: 'assistant' as const,
  ...extra,
});

test('completed paragraphs become fragments that keep their separators', () => {
  const { fragments, tail } = reasoningFragments('first\n\nsecond\n\n', false, 100);
  assert.deepEqual(fragments, [
    { body: 'first', suffix: '\n\n' },
    { body: 'second', suffix: '\n\n' },
  ]);
  assert.equal(tail, '');
});

test('a running tail stays untranslated', () => {
  const { fragments, tail } = reasoningFragments('done\n\nstill writing', true, 100);
  assert.deepEqual(fragments, [{ body: 'done', suffix: '\n\n' }]);
  assert.equal(tail, 'still writing');
});

test('a paragraph longer than the limit is cut at whitespace without losing characters', () => {
  const text = `${'alpha beta gamma '.repeat(12)}end`;
  const { fragments } = reasoningFragments(text, false, 40);
  assert.ok(fragments.length > 1);
  for (const fragment of fragments) assert.ok(fragment.body.length <= 40);
  assert.equal(fragments.map(fragment => fragment.body + fragment.suffix).join(''), text);
});

test('paints the translation once the Host reports its limits', async () => {
  const state = recorder();
  const { transformer } = createReasoningTransformer(state.client);
  assert.equal(transformer.read(request('one\n\ntwo')), undefined, 'no text is painted before routing is known');
  await settle();
  // Routing is known: this read splits the source and starts the batch.
  transformer.read(request('one\n\ntwo'));
  await settle();
  const shown = transformer.read(request('one\n\ntwo'));
  assert.equal(shown?.text, 'ONE\n\nTWO');
  assert.equal(shown?.final, true);
});

test('subscribe tells the reading view to repaint after a batch lands', async () => {
  const state = recorder();
  const { transformer } = createReasoningTransformer(state.client);
  let notified = 0;
  transformer.subscribe?.(() => { notified += 1; });
  transformer.read(request('one'));
  await settle();
  transformer.read(request('one'));
  await settle();
  assert.ok(notified > 0);
});

test('a failed translation keeps the source text and does not throw', async () => {
  const state = recorder();
  state.failTranslate = true;
  const { transformer } = createReasoningTransformer(state.client);
  transformer.read(request('one'));
  await settle();
  transformer.read(request('one'));
  await settle();
  assert.equal(transformer.read(request('one')), undefined, 'failure paints nothing, so the source stays');
});

test('tool prose and answer bodies are left alone', async () => {
  const state = recorder();
  const { transformer } = createReasoningTransformer(state.client);
  await settle();
  assert.equal(transformer.read(request('one', { source: 'tool' })), undefined);
  assert.equal(transformer.read(request('one', { kind: 'body' })), undefined);
});

test('a growing source reuses the fragments that already have a translation', async () => {
  const state = recorder();
  const { transformer } = createReasoningTransformer(state.client);
  transformer.read(request('one\n\npartial', { streaming: true }));
  await settle();
  transformer.read(request('one\n\ntwo', { streaming: false }));
  await settle();
  assert.deepEqual(state.calls, ['one', 'two']);
  assert.equal(transformer.read(request('one\n\ntwo'))?.text, 'ONE\n\nTWO');
});

test('a missing Host route disables translation instead of retrying every paint', async () => {
  const state = recorder();
  state.failLimits = true;
  const { transformer } = createReasoningTransformer(state.client);
  for (let i = 0; i < 5; i += 1) {
    transformer.read(request(`one${i}`));
    await settle();
  }
  assert.equal(state.limitCalls, 1);
  assert.equal(transformer.read(request('one')), undefined);
});

test('dispose stops further notifications and requests', async () => {
  const state = recorder();
  const { transformer, dispose } = createReasoningTransformer(state.client);
  let notified = 0;
  transformer.subscribe?.(() => { notified += 1; });
  transformer.read(request('one\n\ntwo'));
  await settle();
  const before = state.calls.length;
  dispose();
  await settle();
  assert.equal(state.calls.length, before);
  assert.ok(notified > 0);
});

test('show-original hides the translation without re-requesting it', async () => {
  const state = recorder();
  const { transformer, setShowOriginal } = createReasoningTransformer(state.client);
  transformer.read(request('one\n\ntwo'));
  await settle();
  transformer.read(request('one\n\ntwo'));
  await settle();
  assert.equal(transformer.read(request('one\n\ntwo'))?.text, 'ONE\n\nTWO');

  const before = state.calls.length;
  setShowOriginal('block-1', true);
  assert.deepEqual(transformer.read(request('one\n\ntwo')), { text: 'one\n\ntwo', final: true }, 'source explicitly replaces the translation');
  setShowOriginal('block-1', false);
  assert.equal(transformer.read(request('one\n\ntwo'))?.text, 'ONE\n\nTWO', 'cached translation returns');
  assert.equal(state.calls.length, before, 'toggling never re-sends a fragment');
});

test.each(['different', 'identical'])('original toggles isolate two cards with %s source text', async (mode) => {
  const state = recorder();
  const api = createReasoningTransformer(state.client);
  const a = request('one', { blockKey: 'a' });
  const b = request(mode === 'identical' ? 'one' : 'two', { blockKey: 'b' });
  try {
    api.transformer.read(a);
    api.transformer.read(b);
    await flush();
    api.transformer.read(a);
    api.transformer.read(b);
    await flush();
    const before = [...state.calls];
    assert.equal(api.getShowOriginal('a'), false);
    assert.equal(api.getShowOriginal('b'), false);
    api.setShowOriginal('a', true);
    assert.equal(api.getShowOriginal('a'), true);
    assert.equal(api.getShowOriginal('b'), false);
    assert.deepEqual(api.transformer.read(a), { text: a.text, final: true });
    assert.deepEqual(api.transformer.read(b), { text: b.text.toUpperCase(), final: true });
    api.setShowOriginal('b', true);
    assert.deepEqual(api.transformer.read(a), { text: a.text, final: true });
    assert.deepEqual(api.transformer.read(b), { text: b.text, final: true });
    api.setShowOriginal('a', false);
    assert.equal(api.getShowOriginal('b'), true);
    assert.deepEqual(api.transformer.read(a), { text: a.text.toUpperCase(), final: true });
    assert.deepEqual(api.transformer.read(b), { text: b.text, final: true });
    api.setShowOriginal('b', false);
    assert.equal(api.getShowOriginal('b'), false);
    assert.deepEqual(api.transformer.read(b), { text: b.text.toUpperCase(), final: true });
    await flush();
    assert.deepEqual(state.calls, before, 'independent toggles reuse each card cache');
  } finally {
    api.dispose();
  }
});

test('unknown and ignored keys do not acquire toggle state or notify', () => {
  const state = recorder();
  const api = createReasoningTransformer(state.client);
  let notifications = 0;
  api.transformer.subscribe?.(() => { notifications += 1; });
  try {
    api.transformer.read(request('body', { blockKey: 'body', kind: 'body' }));
    api.transformer.read(request('tool', { blockKey: 'tool', source: 'tool' }));
    for (const key of ['unknown', 'body', 'tool']) {
      api.setShowOriginal(key, true);
      assert.equal(api.getShowOriginal(key), false);
    }
    assert.equal(notifications, 0);
    assert.equal(state.limitCalls, 0);
    api.transformer.read(request('one'));
    api.setShowOriginal('block-1', true);
    assert.deepEqual(api.transformer.read(request('one')), { text: 'one', final: true }, 'original is explicit even before limits resolve');
    assert.equal(api.transformer.read(request('body', { kind: 'body' })), undefined);
    assert.equal(api.transformer.read(request('tool', { source: 'tool' })), undefined);
    api.dispose();
    api.setShowOriginal('block-1', true);
    assert.equal(api.getShowOriginal('block-1'), false);
  } finally {
    api.dispose();
  }
});

test('source grows while original is selected and switching back reuses cached translations', async () => {
  const state = recorder();
  const api = createReasoningTransformer(state.client);
  try {
    const initial = request('one\n\npartial', { streaming: true });
    api.transformer.read(initial);
    await flush();
    api.transformer.read(initial);
    await flush();
    assert.deepEqual(state.calls, ['one']);
    api.setShowOriginal('block-1', true);
    const growing = request('one\n\npartial grows', { streaming: true });
    assert.deepEqual(api.transformer.read(growing), { text: growing.text, final: false });
    const grown = request('one\n\ntwo\n\nstill growing', { streaming: true });
    assert.deepEqual(api.transformer.read(grown), { text: grown.text, final: false });
    await flush();
    assert.deepEqual(api.transformer.read(grown), { text: grown.text, final: false });
    assert.deepEqual(state.calls, ['one', 'two'], 'only newly completed source is translated');
    const before = [...state.calls];
    api.setShowOriginal('block-1', false);
    assert.deepEqual(api.transformer.read(grown), { text: 'ONE\n\nTWO\n\nstill growing', final: false });
    await flush();
    assert.deepEqual(state.calls, before, 'switching back reuses both cached fragments');
    api.setShowOriginal('block-1', true);
    const completed = request('one\n\ntwo\n\nfinished');
    assert.deepEqual(api.transformer.read(completed), { text: completed.text, final: true });
  } finally {
    api.dispose();
  }
});

test('an in-flight translation cannot repaint over selected original', async () => {
  const state = recorder();
  let finish: (text: string) => void = () => {};
  state.client.translate = async (text) => {
    state.calls.push(text);
    return new Promise<string>(resolve => { finish = resolve; });
  };
  const api = createReasoningTransformer(state.client);
  const current = request('one');
  const paints: Array<ReturnType<typeof api.transformer.read>> = [];
  const unsubscribe = api.transformer.subscribe?.(() => { paints.push(api.transformer.read(current)); });
  try {
    api.transformer.read(current);
    await flush();
    assert.deepEqual(state.calls, ['one']);
    api.setShowOriginal(current.blockKey, true);
    assert.deepEqual(paints.at(-1), { text: 'one', final: true });
    const selectedAt = paints.length;
    finish('ONE');
    await flush();
    assert.ok(paints.length > selectedAt, 'finishing work triggers a repaint');
    for (const paint of paints.slice(selectedAt)) assert.deepEqual(paint, { text: 'one', final: true });
    api.setShowOriginal(current.blockKey, false);
    assert.deepEqual(paints.at(-1), { text: 'ONE', final: true });
    assert.deepEqual(state.calls, ['one']);
  } finally {
    unsubscribe?.();
    api.dispose();
  }
});

/** Flush promises without advancing fake retry timers. */
async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

test('paragraph breaks preserve CRLF and whitespace exactly', () => {
  assert.deepEqual(reasoningFragments('first\r\n \t\r\n  second', false, 100), {
    fragments: [
      { body: 'first', suffix: '\r\n \t\r\n  ' },
      { body: 'second', suffix: '' },
    ],
    tail: '',
  });
});

test('literal backslash-n text is not a paragraph break', () => {
  const text = String.raw`first\n\nsecond`;
  assert.deepEqual(reasoningFragments(text, true, 100), { fragments: [], tail: text });
});

test('long fragments prefer a real newline to cutting through a word', () => {
  assert.deepEqual(reasoningFragments('abcdef\nghijklmno', false, 10).fragments, [
    { body: 'abcdef', suffix: '' },
    { body: '\nghijklmno', suffix: '' },
  ]);
});

test('source replacement during translation schedules the replacement fragments', async () => {
  const state = recorder();
  let finish: (text: string) => void = () => {};
  state.client.translate = async (text) => {
    state.calls.push(text);
    if (text === 'old') return new Promise<string>(resolve => { finish = resolve; });
    return text.toUpperCase();
  };
  const { transformer, dispose } = createReasoningTransformer(state.client);
  try {
    transformer.read(request('old'));
    await flush();
    transformer.read(request('old'));
    await flush();
    transformer.read(request('replacement'));
    finish('OLD');
    await flush();
    assert.deepEqual(state.calls, ['old', 'replacement']);
    assert.equal(transformer.read(request('replacement'))?.text, 'REPLACEMENT');
  } finally {
    dispose();
  }
});

test('translation retries respect cooldown even when streaming source changes', async () => {
  vi.useFakeTimers();
  const state = recorder();
  state.failTranslate = true;
  const { transformer, dispose } = createReasoningTransformer(state.client);
  try {
    transformer.read(request('one\n\npartial', { streaming: true }));
    await flush();
    transformer.read(request('one\n\npartial', { streaming: true }));
    await flush();
    assert.deepEqual(state.calls, ['one']);
    transformer.read(request('one\n\nmore', { streaming: true }));
    await flush();
    assert.deepEqual(state.calls, ['one'], 'a repaint must not bypass provider backoff');
    state.failTranslate = false;
    await vi.advanceTimersByTimeAsync(8000);
    assert.deepEqual(state.calls, ['one', 'one']);
    assert.equal(transformer.read(request('one\n\nmore', { streaming: true }))?.text, 'ONE\n\nmore');
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

test('idle entry reclamation drops its original selection without retaining a tombstone', async () => {
  vi.useFakeTimers();
  const api = createReasoningTransformer(recorder().client);
  try {
    api.transformer.read(request('one'));
    await flush();
    api.setShowOriginal('block-1', true);
    assert.equal(api.getShowOriginal('block-1'), true);
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    for (let index = 0; index < 512; index += 1) {
      api.transformer.read(request('', { blockKey: `other-${index}` }));
    }
    assert.equal(api.getShowOriginal('block-1'), false, 'selection is owned by the reclaimed entry');
    api.setShowOriginal('block-1', true);
    assert.equal(api.getShowOriginal('block-1'), false, 'nonadmitted keys remain no-ops after eviction');
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    api.transformer.read(request('one'));
    assert.equal(api.getShowOriginal('block-1'), false, 'readmission starts with translation selected');
  } finally {
    api.dispose();
    vi.useRealTimers();
  }
});

test('reclaiming an idle failed block cancels its scheduled retry', async () => {
  vi.useFakeTimers();
  const state = recorder();
  state.failTranslate = true;
  const { transformer, dispose } = createReasoningTransformer(state.client);
  try {
    transformer.read(request('one'));
    await flush();
    transformer.read(request('one'));
    await flush();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    for (let index = 0; index < 512; index += 1) {
      transformer.read(request('', { blockKey: `other-${index}` }));
    }
    await flush();
    state.failTranslate = false;
    await vi.advanceTimersByTimeAsync(8000);
    assert.deepEqual(state.calls, ['one'], 'an evicted card must not send a retry');
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

test('idle work reclaimed while waiting in the serial queue never reaches the client', async () => {
  vi.useFakeTimers();
  const state = recorder();
  let finish: (text: string) => void = () => {};
  state.client.translate = async (text) => {
    state.calls.push(text);
    if (text === 'busy') return new Promise<string>(resolve => { finish = resolve; });
    return text.toUpperCase();
  };
  const { transformer, dispose } = createReasoningTransformer(state.client);
  try {
    transformer.read(request('busy'));
    await flush();
    transformer.read(request('busy'));
    await flush();
    transformer.read(request('queued', { blockKey: 'queued' }));
    await flush();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    for (let index = 0; index < 512; index += 1) {
      transformer.read(request('', { blockKey: `other-${index}` }));
    }
    finish('BUSY');
    await flush();
    assert.deepEqual(state.calls, ['busy']);
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

test('retries are bounded and disposal clears retry timers', async () => {
  vi.useFakeTimers();
  const state = recorder();
  state.failTranslate = true;
  const { transformer, dispose } = createReasoningTransformer(state.client);
  try {
    transformer.read(request('one'));
    await flush();
    transformer.read(request('one'));
    await flush();
    for (const delay of [8000, 16000, 24000]) await vi.advanceTimersByTimeAsync(delay);
    assert.equal(state.calls.length, 4, 'one initial request plus three retries');
    await vi.advanceTimersByTimeAsync(100000);
    assert.equal(state.calls.length, 4, 'retry exhaustion schedules no further requests');
    transformer.read(request('two', { blockKey: 'other' }));
    await flush();
    assert.equal(vi.getTimerCount(), 1);
    dispose();
    assert.equal(vi.getTimerCount(), 0, 'disposal releases retry timers');
  } finally {
    dispose();
    vi.useRealTimers();
  }
});

test('subscriber repaints translate completed streaming paragraphs and then settle the tail', async () => {
  const state = recorder();
  const { transformer, dispose } = createReasoningTransformer(state.client);
  let current = request('one\n\npartial', { streaming: true });
  const paints: Array<ReturnType<typeof transformer.read>> = [];
  const repaint = () => { paints.push(transformer.read(current)); };
  transformer.subscribe?.(repaint);
  try {
    repaint();
    await flush();
    assert.equal(paints.at(-1)?.text, 'ONE\n\npartial');
    assert.equal(paints.at(-1)?.final, false);
    current = request('one\n\ntwo');
    repaint();
    await flush();
    assert.equal(paints.at(-1)?.text, 'ONE\n\nTWO');
    assert.equal(paints.at(-1)?.final, true);
    assert.deepEqual(state.calls, ['one', 'two']);
  } finally {
    dispose();
  }
});
