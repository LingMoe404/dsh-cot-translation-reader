import { test } from 'vitest';
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
