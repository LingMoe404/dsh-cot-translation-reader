/** Return a canonical, concrete BCP 47 tag, never a wildcard or auto sentinel. */
export function concreteLanguageTag(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 255) return undefined;
  const tag = value.trim();
  if (!tag || tag === '*' || tag.toLowerCase() === 'auto') return undefined;
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}
