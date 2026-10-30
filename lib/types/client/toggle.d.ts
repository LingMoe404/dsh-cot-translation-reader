/** Per-card original/translation controls, bound only through public block IDs. */
interface ToggleApi {
    getShowOriginal(blockKey: string): boolean;
    setShowOriginal(blockKey: string, value: boolean): void;
}
/** One initial scan, then only affected cards; no global display toggle. */
export declare function installOriginalToggle(api: ToggleApi): () => void;
export {};
//# sourceMappingURL=toggle.d.ts.map