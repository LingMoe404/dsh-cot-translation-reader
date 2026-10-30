/**
 * Per-card 查看原文 / 查看译文 control.
 *
 * The text-transform seam only supplies a string — a registrant cannot mount a
 * React component into the reader's reasoning card. This module therefore adds
 * one small button to each card's heading and keeps it there across the
 * reader's re-renders, mirroring the official bundle's toolbar control.
 */
interface ToggleApi {
    getShowOriginal(): boolean;
    setShowOriginal(value: boolean): void;
}
/**
 * Add the control to every mounted reasoning card.
 *
 * @param api - transformer toggle.
 * @returns disposer removing every injected button and the observer.
 */
export declare function installOriginalToggle(api: ToggleApi): () => void;
export {};
//# sourceMappingURL=toggle.d.ts.map