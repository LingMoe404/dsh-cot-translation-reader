# Changelog

## 0.1.7 — 2026-10-30

### Fixed

- Resolve automatic translation from the active UI locale, then document/browser language; validate concrete language tags and never send an `Accept-Language: *` wildcard as a provider target.
- Bundle local Host imports correctly on Windows so the published entry does not refer to missing TypeScript files.
- Avoid cache eviction/retranslation feedback during global reader notifications. Retain up to 512 entries, reclaim only entries idle for at least five minutes, and preserve source text when no safe cache slot is available.
- Scope original/translated selection to the exact reasoning block keys of the clicked card. Identical text in different cards no longer shares selection. Source mode explicitly returns the current growing source and preserves cached translations for switching back.
- Keep streaming replacement, retry cooldown, queued cancellation and disposal safe.
- Maintain controls incrementally instead of rescanning the document on every stream mutation. Identity-less readers fail closed instead of guessing by text or DOM order.

### Release validation

- Source tests plus isolated Host import and browser factory checks.
- Built-browser synthetic stability checks for 40, 41, 45, 100, 512 and 600 mounted-card scenarios.
- Trusted Publishing verifies the tag/package version and rebuilds/checks artifacts before publication. No npm token or disabled 2FA is required.

### Compatibility

Automatic reading-view translation requires the `dsh-better-display.text-transform` seam (better-display >= 0.3.9) and a Host translator. Official COT bundle preferences remain authoritative when installed.

**Per-card original/translated buttons additionally require `data-reader-reasoning-block-key`.** The companion reader patch is [better-display PR #82](https://github.com/aa2246740/dsh-better-display/pull/82), not yet merged/released at this publication. The published better-display 0.3.9 supports automatic translation but will not show these buttons with this adapter version. Do not expect a reader upgrade to be installed automatically.

Validation above is automated/source/synthetic coverage; it is not a claim that the new paired per-card implementation has passed a live Desktop UI test.
