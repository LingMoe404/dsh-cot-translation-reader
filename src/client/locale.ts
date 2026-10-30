import { concreteLanguageTag } from '../language.js';

/** Resolve automatic translation from the UI first, never from HTTP wildcards. */
export function browserTranslationLocale(activeLocale?: unknown): string {
  const candidates: unknown[] = [activeLocale];
  if (typeof document !== 'undefined') candidates.push(document.documentElement?.lang);
  if (typeof navigator !== 'undefined') candidates.push(...(navigator.languages ?? []), navigator.language);
  for (const candidate of candidates) {
    const tag = concreteLanguageTag(candidate);
    if (tag) return tag;
  }
  return 'en';
}
