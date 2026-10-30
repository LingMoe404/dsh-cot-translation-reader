import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { installOriginalToggle } from '../src/client/toggle.js';
import { createReasoningTransformer } from '../src/client/transformer.js';

const CARD = 'data-reader-reasoning-card';
const HEADING = 'data-reader-reasoning-heading';
const BUTTON = 'data-cot-translation-toggle';
const BLOCK_KEY = 'data-reader-reasoning-block-key';
let cardSequence = 0;

/** Only the DOM surface used by the toggle; mutations never fire automatically. */
class FakeElement extends EventTarget {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  private text = '';
  textWrites = 0;
  get textContent() { return this.text; }
  set textContent(value: string) { this.textWrites++; this.text = value; }
  type = '';

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  matches(selector: string): boolean {
    return selector.split(',').some(part => this.attributes.has(part.trim().slice(1, -1)));
  }
  closest(selector: string): FakeElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  get isConnected(): boolean {
    return this instanceof FakeDocument || (this.parent?.isConnected ?? false);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  appendChild(child: FakeElement) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  click() {
    const event = new Event('click', { bubbles: true, cancelable: true });
    this.dispatchEvent(event);
    return event;
  }
}

class FakeDocument extends FakeElement {
  body: FakeElement | null = new FakeElement();
  scans = 0;
  override querySelectorAll(selector: string): FakeElement[] {
    this.scans++;
    return super.querySelectorAll(selector);
  }
  constructor(ready: boolean) {
    super();
    if (ready) this.appendChild(this.body!);
    else this.body = null;
  }
  createElement() { return new FakeElement(); }
  mountBody() {
    this.body = this.appendChild(new FakeElement());
  }
}

interface FakeMutation {
  type?: 'childList' | 'attributes';
  attributeName?: string;
  target: FakeElement;
  addedNodes: FakeElement[];
  removedNodes: FakeElement[];
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(public callback: (records: FakeMutation[]) => void) {
    FakeObserver.instances.push(this);
  }
  deliver(...addedNodes: FakeElement[]) {
    this.mutate({ target: addedNodes[0]?.parent ?? this.observe.mock.calls[0][0], addedNodes });
  }
  mutate(...records: Array<Pick<FakeMutation, 'target'> & Partial<FakeMutation>>) {
    this.callback(records.map(record => ({ addedNodes: [], removedNodes: [], ...record })));
  }
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(ready = true, initial = false) {
  const document = new FakeDocument(ready);
  FakeObserver.instances = [];
  cardSequence = 0;
  vi.stubGlobal('document', document);
  vi.stubGlobal('Element', FakeElement);
  vi.stubGlobal('MutationObserver', FakeObserver);
  const original = new Map<string, boolean>();
  const api = {
    getShowOriginal: (key: string) => original.get(key) ?? initial,
    setShowOriginal: vi.fn((key: string, value: boolean) => { original.set(key, value); }),
  };
  return { document, api };
}

function addCard(root: FakeElement, keys = [`card-${++cardSequence}`]) {
  const card = root.appendChild(new FakeElement());
  card.setAttribute(CARD, '');
  const heading = card.appendChild(new FakeElement());
  heading.setAttribute(HEADING, '');
  const blocks = keys.map(key => {
    const block = card.appendChild(new FakeElement());
    block.setAttribute(BLOCK_KEY, key);
    return block;
  });
  return { card, heading, blocks, key: keys[0] ?? '' };
}

function install(api: Parameters<typeof installOriginalToggle>[0]) {
  const dispose = installOriginalToggle(api);
  disposers.push(dispose);
  return dispose;
}

function assertLabels(document: FakeDocument, original: boolean, count: number) {
  // Assertions must not count as production document scans.
  const buttons = document.body?.querySelectorAll(`[${BUTTON}]`) ?? [];
  assert.equal(buttons.length, count);
  for (const button of buttons) {
    assert.equal(button.type, 'button');
    assert.equal(button.textContent, original ? '查看译文' : '查看原文');
    assert.equal(button.getAttribute('aria-label'), original ? '显示译文' : '显示原文');
    // Changing action labels describe the next action, not a persistent pressed state.
    assert.equal(button.getAttribute('aria-pressed'), null);
  }
  return buttons;
}

test('click updates only its own card synchronously without mutation delivery', () => {
  const { document, api } = setup();
  const first = addCard(document.body!);
  const second = addCard(document.body!);
  install(api);
  const buttons = assertLabels(document, false, 2);
  assert.equal(buttons[0].click().defaultPrevented, true);
  assert.equal(api.getShowOriginal(first.key), true);
  assert.equal(api.getShowOriginal(second.key), false);
  assert.deepEqual(buttons.map(button => button.textContent), ['查看译文', '查看原文']);
  buttons[1].click();
  assert.equal(api.getShowOriginal(first.key), true);
  assert.equal(api.getShowOriginal(second.key), true);
  assertLabels(document, true, 2);
  buttons[0].click();
  assert.deepEqual(buttons.map(button => button.textContent), ['查看原文', '查看译文']);
  assert.deepEqual(api.setShowOriginal.mock.calls, [[first.key, true], [second.key, true], [first.key, false]]);
});

test('new cards and restored controls inherit current state without duplicates', () => {
  const { document, api } = setup(true, true);
  const first = addCard(document.body!);
  install(api);
  const observer = FakeObserver.instances[0];
  const second = addCard(document.body!);
  observer.deliver(second.card);
  assertLabels(document, true, 2);
  const removed = first.heading.querySelector(`[${BUTTON}]`)!;
  removed.remove();
  observer.mutate({ target: first.heading, removedNodes: [removed] });
  const buttons = assertLabels(document, true, 2);
  observer.deliver(second.card);
  assertLabels(document, true, 2);
  buttons[1].click();
  assert.deepEqual(buttons.map(button => button.textContent), ['查看译文', '查看原文']);
  assert.equal(api.getShowOriginal(first.key), true);
  assert.equal(api.getShowOriginal(second.key), false);
});

test('dispose removes controls, disconnects and ignores queued mutation callbacks', () => {
  const { document, api } = setup();
  addCard(document.body!);
  const dispose = install(api);
  const button = assertLabels(document, false, 1)[0];
  const observer = FakeObserver.instances[0];
  dispose();
  assert.equal(observer.disconnect.mock.calls.length, 1);
  observer.deliver(addCard(document.body!).card);
  assertLabels(document, false, 0);
  button.click();
  assert.equal(api.setShowOriginal.mock.calls.length, 0);
});

test('DOMContentLoaded mounts controls once when still active', () => {
  const { document, api } = setup(false);
  const add = vi.spyOn(document, 'addEventListener');
  install(api);
  const start = add.mock.calls.find(([type]) => type === 'DOMContentLoaded')![1];
  const observer = FakeObserver.instances[0];
  assert.equal(observer.observe.mock.calls.length, 0);
  document.mountBody();
  addCard(document.body!);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  (start as EventListener)(new Event('DOMContentLoaded'));
  assert.equal(observer.observe.mock.calls.length, 1);
  assert.equal(document.scans, 1);
  assertLabels(document, false, 1);
});

test('dispose removes DOMContentLoaded listener and prevents delayed mounting', () => {
  const { document, api } = setup(false);
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  const dispose = install(api);
  const start = add.mock.calls.find(([type]) => type === 'DOMContentLoaded')![1];
  dispose();
  assert.equal(remove.mock.calls.some(([type, callback]) => type === 'DOMContentLoaded' && callback === start), true);
  document.mountBody();
  addCard(document.body!);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  // Even a callback retained by an event queue cannot revive a disposed install.
  (start as EventListener)(new Event('DOMContentLoaded'));
  assert.equal(FakeObserver.instances[0].observe.mock.calls.length, 0);
  assertLabels(document, false, 0);
});

test('unrelated stream churn never rescans the document or existing cards', () => {
  const { document, api } = setup();
  const { card } = addCard(document.body!);
  const content = card.appendChild(new FakeElement());
  const unrelated = document.body!.appendChild(new FakeElement());
  install(api);
  assert.equal(document.scans, 1);
  const inspectCard = vi.spyOn(card, 'querySelector');
  const observer = FakeObserver.instances[0];
  for (let i = 0; i < 100; i++) {
    for (const target of [content, unrelated]) {
      const node = target.appendChild(new FakeElement());
      node.appendChild(new FakeElement());
      observer.mutate({ target, addedNodes: [node] });
      node.remove();
      observer.mutate({ target, removedNodes: [node] });
    }
  }
  assert.equal(inspectCard.mock.calls.length, 0);
  const button = assertLabels(document, false, 1)[0];
  button.click();
  assertLabels(document, true, 1);
  assert.equal(document.scans, 1);
});

test('batched wrapper/card additions converge once per mounted card', () => {
  const { document, api } = setup(true, true);
  install(api);
  const wrapper = document.body!.appendChild(new FakeElement());
  const first = addCard(wrapper);
  const second = addCard(wrapper);
  const inspectFirst = vi.spyOn(first.card, 'querySelector');
  const observer = FakeObserver.instances[0];
  observer.mutate(
    { target: document.body!, addedNodes: [wrapper] },
    { target: wrapper, addedNodes: [first.card, second.card] },
    { target: first.card, addedNodes: [first.heading] },
  );
  assertLabels(document, true, 2);
  assert.equal(inspectFirst.mock.calls.length, 1);
  // Deliver the mutations produced by injection/painting: no duplicates or
  // repeated text writes should be needed once the labels have converged.
  const buttons = assertLabels(document, true, 2);
  const paint = vi.spyOn(buttons[0], 'textContent', 'set');
  observer.mutate(
    { target: first.heading, addedNodes: [buttons[0]] },
    { target: buttons[0] },
  );
  assertLabels(document, true, 2);
  assert.equal(paint.mock.calls.length, 0);
  assert.equal(document.scans, 1);
});

test('heading-only replacements and direct button removals restore controls locally', () => {
  const { document, api } = setup();
  const { card, heading } = addCard(document.body!);
  install(api);
  const oldButton = assertLabels(document, false, 1)[0];
  const observer = FakeObserver.instances[0];
  heading.remove();
  const wrapper = card.appendChild(new FakeElement());
  const replacement = wrapper.appendChild(new FakeElement());
  replacement.setAttribute(HEADING, '');
  observer.mutate({ target: card, removedNodes: [heading], addedNodes: [wrapper] });
  const button = assertLabels(document, false, 1)[0];
  assert.notEqual(button, oldButton);
  button.remove();
  observer.mutate({ target: replacement, removedNodes: [button] });
  const restored = assertLabels(document, false, 1)[0];
  restored.click();
  assertLabels(document, true, 1);
  assert.equal(oldButton.textContent, '查看原文');
  assert.equal(button.textContent, '查看原文');
  assert.equal(document.scans, 1);
});

test('removed cards and stale additions stay detached; reinserted cards recover', () => {
  const { document, api } = setup();
  const { card } = addCard(document.body!);
  const dispose = install(api);
  const button = assertLabels(document, false, 1)[0];
  const observer = FakeObserver.instances[0];
  card.remove();
  const detached = addCard(new FakeElement());
  observer.mutate(
    { target: document.body!, removedNodes: [card] },
    { target: document.body!, addedNodes: [detached.card] },
  );
  assert.equal(detached.heading.children.length, 0);
  assertLabels(document, false, 0);
  document.body!.appendChild(card);
  observer.deliver(card);
  assert.equal(assertLabels(document, false, 1)[0], button);
  button.click();
  assertLabels(document, true, 1);
  dispose();
  dispose();
  observer.deliver(card);
  button.click();
  assertLabels(document, true, 0);
  assert.equal(api.setShowOriginal.mock.calls.length, 1);
  assert.equal(observer.disconnect.mock.calls.length, 1);
  assert.equal(document.scans, 1);
});

test('missing identity fails closed and later identity changes bind the right block', () => {
  const { document, api } = setup();
  const { card } = addCard(document.body!, []);
  install(api);
  assertLabels(document, false, 0);
  const block = card.appendChild(new FakeElement());
  block.setAttribute(BLOCK_KEY, 'A');
  const observer = FakeObserver.instances[0];
  observer.mutate({ target: card, addedNodes: [block] });
  const button = assertLabels(document, false, 1)[0];
  button.click();
  assert.equal(api.getShowOriginal('A'), true);
  block.setAttribute(BLOCK_KEY, 'B');
  observer.mutate({ type: 'attributes', attributeName: BLOCK_KEY, target: block });
  assertLabels(document, false, 1);
  button.click();
  assert.equal(api.getShowOriginal('B'), true);
  assert.deepEqual(api.setShowOriginal.mock.calls, [['A', true], ['B', true]]);
  block.removeAttribute(BLOCK_KEY);
  observer.mutate({ type: 'attributes', attributeName: BLOCK_KEY, target: block });
  assertLabels(document, false, 0);
  button.click();
  assert.equal(api.setShowOriginal.mock.calls.length, 2);
  assert.deepEqual(observer.observe.mock.calls[0][1].attributeFilter, [BLOCK_KEY]);
});

test('identical displayed text and reordered cards never determine toggle identity', () => {
  const { document, api } = setup();
  const first = addCard(document.body!, ['A']);
  const second = addCard(document.body!, ['B']);
  first.blocks[0].textContent = second.blocks[0].textContent = 'identical translation';
  install(api);
  const firstButton = first.heading.querySelector(`[${BUTTON}]`)!;
  const secondButton = second.heading.querySelector(`[${BUTTON}]`)!;
  document.body!.children.reverse();
  FakeObserver.instances[0].mutate({ target: document.body!, addedNodes: [second.card, first.card] });
  secondButton.click();
  assert.equal(api.getShowOriginal('A'), false);
  assert.equal(api.getShowOriginal('B'), true);
  assert.equal(firstButton.textContent, '查看原文');
  assert.equal(secondButton.textContent, '查看译文');
  assert.deepEqual(api.setShowOriginal.mock.calls, [['B', true]]);
  assert.equal(document.scans, 1);
});

test('a grouped card toggles its blocks together but excludes sibling and nested cards', () => {
  const { document, api } = setup();
  const group = addCard(document.body!, ['A1', 'A2']);
  const nested = addCard(group.card, ['nested']);
  const sibling = addCard(document.body!, ['B']);
  install(api);
  const button = group.heading.querySelector(`[${BUTTON}]`)!;
  button.click();
  assert.deepEqual(api.setShowOriginal.mock.calls, [['A1', true], ['A2', true]]);
  assert.equal(api.getShowOriginal('nested'), false);
  assert.equal(api.getShowOriginal('B'), false);
  assert.equal(nested.heading.querySelector(`[${BUTTON}]`)!.textContent, '查看原文');
  assert.equal(sibling.heading.querySelector(`[${BUTTON}]`)!.textContent, '查看原文');
  button.click();
  assert.equal(api.getShowOriginal('A1'), false);
  assert.equal(api.getShowOriginal('A2'), false);
});

test('a card without its own heading never borrows a nested card heading', () => {
  const { document, api } = setup();
  const parent = addCard(document.body!, ['parent']);
  parent.heading.remove();
  const nested = addCard(parent.card, ['nested']);
  install(api);
  const buttons = assertLabels(document, false, 1);
  assert.equal(buttons[0], nested.heading.querySelector(`[${BUTTON}]`));
  buttons[0].click();
  assert.deepEqual(api.setShowOriginal.mock.calls, [['nested', true]]);
  assert.equal(api.getShowOriginal('parent'), false);
});

test('button clicks integrate with real transformer: only the clicked identical-text card changes', async () => {
  const { document } = setup();
  const first = addCard(document.body!, ['A']);
  const second = addCard(document.body!, ['B']);
  const translate = vi.fn(async (text: string) => text.toUpperCase());
  const api = createReasoningTransformer({
    async limits() { return { maxTextChars: 4000, provider: 'mock', targetLanguage: 'zh' }; },
    translate,
  });
  disposers.push(api.dispose);
  const requests = ['A', 'B'].map(blockKey => ({
    text: 'same source reasoning', blockKey, streaming: false,
    kind: 'reasoning' as const, source: 'assistant' as const,
  }));
  const render = () => {
    [first, second].forEach((card, index) => {
      card.blocks[0].textContent = api.transformer.read(requests[index])?.text ?? requests[index].text;
    });
  };
  const unsubscribe = api.transformer.subscribe?.(render);
  if (unsubscribe) disposers.push(unsubscribe);
  render();
  install(api);
  await vi.waitFor(() => {
    assert.equal(first.blocks[0].textContent, 'SAME SOURCE REASONING');
    assert.equal(second.blocks[0].textContent, 'SAME SOURCE REASONING');
  });
  const firstButton = first.heading.querySelector(`[${BUTTON}]`)!;
  const secondButton = second.heading.querySelector(`[${BUTTON}]`)!;
  firstButton.click();
  assert.equal(first.blocks[0].textContent, 'same source reasoning');
  assert.equal(second.blocks[0].textContent, 'SAME SOURCE REASONING');
  assert.equal(firstButton.textContent, '查看译文');
  assert.equal(secondButton.textContent, '查看原文');
  secondButton.click();
  assert.equal(second.blocks[0].textContent, 'same source reasoning');
  firstButton.click();
  assert.equal(first.blocks[0].textContent, 'SAME SOURCE REASONING');
  assert.equal(second.blocks[0].textContent, 'same source reasoning');
  assert.equal(translate.mock.calls.length, 2, 'source switches preserve both cached translations');
});

test('installation is a safe no-op without a document', () => {
  vi.stubGlobal('document', undefined);
  const api = { getShowOriginal: () => false, setShowOriginal: vi.fn() };
  install(api)();
  assert.equal(api.setShowOriginal.mock.calls.length, 0);
});
