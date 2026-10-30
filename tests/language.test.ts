import { test } from 'vitest';
import assert from 'node:assert/strict';
import { concreteLanguageTag } from '../src/language.js';

test('concreteLanguageTag canonicalizes valid locale tags', () => {
  assert.equal(concreteLanguageTag(' zh-cn '), 'zh-CN');
  assert.equal(concreteLanguageTag('EN-us'), 'en-US');
  assert.equal(concreteLanguageTag('zh-Hant-TW'), 'zh-Hant-TW');
  assert.equal(concreteLanguageTag('iw'), 'he');
});

test('concreteLanguageTag rejects sentinels, malformed, non-string and oversized input', () => {
  for (const value of [undefined, null, 0, {}, ['zh-CN'], '', ' ', '*', ' * ', 'auto', 'AUTO', 'en_US', 'en,zh', 'en;q=1', 'x'.repeat(256), `${' '.repeat(256)}en`]) {
    assert.equal(concreteLanguageTag(value), undefined, `unexpected valid tag: ${JSON.stringify(value)}`);
  }
});
