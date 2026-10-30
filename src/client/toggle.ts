/** Per-card original/translation controls, bound only through public block IDs. */
interface ToggleApi {
  getShowOriginal(blockKey: string): boolean;
  setShowOriginal(blockKey: string, value: boolean): void;
}

const CARD = '[data-reader-reasoning-card]';
const HEADING = '[data-reader-reasoning-heading]';
const BLOCK_KEY = 'data-reader-reasoning-block-key';
const BUTTON_FLAG = 'data-cot-translation-toggle';
const LABEL_ORIGINAL = '查看原文';
const LABEL_TRANSLATED = '查看译文';
const BUTTON_CSS = [
  'margin-left:auto', 'padding:0 6px', 'min-height:20px', 'border:0',
  'border-radius:6px', 'background:transparent', 'color:inherit', 'font:inherit',
  'font-size:12px', 'line-height:20px', 'cursor:pointer', 'white-space:nowrap',
].join(';');

/** Never infer identity from source text, translated text, or card order. */
function blockKeys(card: Element): string[] {
  const keys = new Set<string>();
  for (const node of card.querySelectorAll(`[${BLOCK_KEY}]`)) {
    if (node.closest(CARD) !== card) continue;
    const key = node.getAttribute(BLOCK_KEY);
    if (key) keys.add(key);
  }
  return [...keys];
}

function showingOriginal(api: ToggleApi, keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every(key => api.getShowOriginal(key));
}

function paint(button: HTMLButtonElement, api: ToggleApi, keys: readonly string[]): void {
  const original = showingOriginal(api, keys);
  const label = original ? LABEL_TRANSLATED : LABEL_ORIGINAL;
  const accessible = original ? '显示译文' : '显示原文';
  if (button.textContent !== label) button.textContent = label;
  if (button.getAttribute('aria-label') !== accessible) button.setAttribute('aria-label', accessible);
}

/** One initial scan, then only affected cards; no global display toggle. */
export function installOriginalToggle(api: ToggleApi): () => void {
  if (typeof document === 'undefined') return () => {};
  let disposed = false;
  let started = false;
  const buttons = new Set<HTMLButtonElement>();
  const owned = new WeakSet<HTMLButtonElement>();
  const cardButtons = new WeakMap<Element, HTMLButtonElement>();

  const onToggle = (button: HTMLButtonElement) => {
    if (disposed || !buttons.has(button) || !button.isConnected) return;
    // Resolve the current owner even if a renderer moved an existing button.
    const card = button.closest(CARD);
    if (!card) return;
    const keys = blockKeys(card);
    if (keys.length === 0) { syncCard(card); return; }
    const value = !showingOriginal(api, keys);
    for (const key of keys) api.setShowOriginal(key, value);
    syncCard(card);
  };

  const syncCard = (card: Element) => {
    const previous = cardButtons.get(card);
    if (previous && (!previous.isConnected || previous.closest(CARD) === card)) buttons.delete(previous);
    cardButtons.delete(card);
    if (!card.isConnected) return;
    const heading = card.querySelector(HEADING);
    if (!heading || heading.closest(CARD) !== card) return;
    const keys = blockKeys(card);
    let button = heading.querySelector<HTMLButtonElement>(`[${BUTTON_FLAG}]`);
    if (keys.length === 0) {
      // Older readers lack a public identity seam. Fail closed, not on another card.
      if (button) { buttons.delete(button); button.remove(); }
      return;
    }
    if (button && !owned.has(button)) { button.remove(); button = null; }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.setAttribute(BUTTON_FLAG, '');
      button.setAttribute('style', BUTTON_CSS);
      const control = button;
      control.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle(control);
      });
      owned.add(control);
      heading.appendChild(control);
    }
    paint(button, api, keys);
    cardButtons.set(card, button);
    buttons.add(button);
  };

  const related = `${CARD}, ${HEADING}, [${BUTTON_FLAG}], [${BLOCK_KEY}]`;
  const observer = new MutationObserver((records) => {
    if (disposed) return;
    const cards = new Set<Element>();
    const collect = (node: Node, removed: boolean): boolean => {
      if (!(node instanceof Element)) return false;
      const elements = [...node.querySelectorAll(related)];
      if (node.matches(related)) elements.push(node);
      for (const element of elements) {
        if (removed && element.matches(`[${BUTTON_FLAG}]`)) buttons.delete(element as HTMLButtonElement);
        const card = element.closest(CARD);
        if (card) cards.add(card);
      }
      return elements.length > 0;
    };
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.attributeName === BLOCK_KEY && record.target instanceof Element) {
          const card = record.target.closest(CARD);
          if (card) cards.add(card);
        }
        continue;
      }
      let changed = false;
      for (const node of record.removedNodes) changed = collect(node, true) || changed;
      for (const node of record.addedNodes) changed = collect(node, false) || changed;
      if (record.target instanceof Element && (changed || record.target.closest(HEADING))) {
        const card = record.target.closest(CARD);
        if (card) cards.add(card);
      }
    }
    for (const card of cards) syncCard(card);
  });

  const start = () => {
    if (disposed || started || !document.body) return;
    started = true;
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: [BLOCK_KEY],
    });
    for (const card of document.querySelectorAll(CARD)) syncCard(card);
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });

  return () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener('DOMContentLoaded', start);
    observer.disconnect();
    for (const button of buttons) button.remove();
    buttons.clear();
  };
}
