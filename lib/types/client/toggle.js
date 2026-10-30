/**
 * Per-card 查看原文 / 查看译文 control.
 *
 * The text-transform seam only supplies a string — a registrant cannot mount a
 * React component into the reader's reasoning card. This module therefore adds
 * one small button to each card's heading and keeps it there across the
 * reader's re-renders, mirroring the official bundle's toolbar control.
 */
const CARD = '[data-reader-reasoning-card]';
const HEADING = '[data-reader-reasoning-heading]';
const BUTTON_FLAG = 'data-cot-translation-toggle';
const LABEL_ORIGINAL = '查看原文';
const LABEL_TRANSLATED = '查看译文';
const BUTTON_CSS = [
    'margin-left:auto',
    'padding:0 6px',
    'min-height:20px',
    'border:0',
    'border-radius:6px',
    'background:transparent',
    'color:inherit',
    'font:inherit',
    'font-size:12px',
    'line-height:20px',
    'cursor:pointer',
    'white-space:nowrap',
].join(';');
function labelFor(api) {
    return api.getShowOriginal() ? LABEL_TRANSLATED : LABEL_ORIGINAL;
}
function paint(button, api) {
    const label = labelFor(api);
    if (button.textContent !== label)
        button.textContent = label;
    button.setAttribute('aria-label', api.getShowOriginal() ? '显示译文' : '显示原文');
}
function attach(card, api) {
    const heading = card.querySelector(HEADING);
    if (!heading)
        return;
    let button = heading.querySelector(`[${BUTTON_FLAG}]`);
    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.setAttribute(BUTTON_FLAG, '');
        button.setAttribute('style', BUTTON_CSS);
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            // Switching re-reads every card, so one click is enough for the session.
            api.setShowOriginal(!api.getShowOriginal());
        });
        heading.appendChild(button);
    }
    paint(button, api);
}
function sync(root, api) {
    for (const card of root.querySelectorAll(CARD))
        attach(card, api);
}
/**
 * Add the control to every mounted reasoning card.
 *
 * @param api - transformer toggle.
 * @returns disposer removing every injected button and the observer.
 */
export function installOriginalToggle(api) {
    if (typeof document === 'undefined')
        return () => { };
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (!(node instanceof Element))
                    continue;
                if (node.matches(CARD))
                    attach(node, api);
                else
                    sync(node, api);
            }
        }
        // A re-render can also drop the button without adding a card node.
        sync(document, api);
    });
    const start = () => {
        observer.observe(document.body, { childList: true, subtree: true });
        sync(document, api);
    };
    if (document.body)
        start();
    else
        document.addEventListener('DOMContentLoaded', start, { once: true });
    return () => {
        observer.disconnect();
        for (const button of document.querySelectorAll(`[${BUTTON_FLAG}]`))
            button.remove();
    };
}
//# sourceMappingURL=toggle.js.map