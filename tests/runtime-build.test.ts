import { describe, expect, it } from 'vitest';
import { externalClientBundle } from '../tools/client-build.js';
import { checkClient } from '../tools/check-runtime.mjs';

const id = 'dsh-cot-translation-reader';
const [host, client] = externalClientBundle(id, ['src/index.ts'], {
  clientEntry: 'src/client/index.ts',
});

describe('runtime build recipe (no build required)', () => {
  it.each([
    './language.js', '../language.ts', '/repo/src/language.ts',
    'G:/Code/plugin/src/language.ts', String.raw`G:\Code\plugin\src\language.ts`,
    String.raw`\\server\share\language.ts`, '//server/share/language.ts',
    'file:///G:/Code/plugin/src/language.ts', '\0virtual:local', 'data:text/javascript,export{}',
  ])('bundles local specifier or resolved ID %s', specifier => {
    expect(host.deps.neverBundle(specifier)).toBe(false);
    expect(host.deps.alwaysBundle(specifier)).toBe(true);
  });

  it.each(['node:fs', 'react', 'react/jsx-runtime', '@deepseek-ai/cordis', 'some-package/subpath']) (
    'keeps Host bare dependency %s external', specifier => {
      expect(host.deps.neverBundle(specifier)).toBe(true);
      expect(host.deps.alwaysBundle(specifier)).toBe(false);
    },
  );

  it('retains the client external and cross-plugin purity policy', () => {
    expect(client.deps.neverBundle('react')).toBe(true);
    expect(client.deps.alwaysBundle('./locale.js')).toBe(true);
    expect(client.deps.alwaysBundle('G:/repo/src/client/locale.ts')).toBe(true);
    const purity = client.plugins.find(plugin => plugin.name === 'dshx-client-bundle-purity');
    expect(() => purity.resolveId('@deepseek-ai/dsh-unapproved/value')).toThrow('client bundle purity');
    expect(purity.resolveId('@deepseek-ai/cordis')).toBeNull();
    expect(purity.resolveId('@deepseek-ai/dsh-session')).toBeNull();
  });
});

const wrapper = (body: string) => `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)}, factory: require => { ${body} }
});`;
const exports = `return { name: 'cot-translation-reader', inject: [],
  apply() { throw new Error('must never mount'); }, createHttpTranslationClient() {} };`;

describe('isolated browser factory smoke check', () => {
  it('executes the loader factory without applying the plugin', () => {
    expect(() => checkClient(wrapper(exports))).not.toThrow();
  });

  it('fails when an unbundled local module is required inside the factory', () => {
    expect(() => checkClient(wrapper(`require('./locale.ts'); ${exports}`)))
      .toThrow('Unexpected browser require: ./locale.ts');
  });

  it('fails when the wrapper registers without exporting the plugin', () => {
    expect(() => checkClient(wrapper('return {};'))).toThrow();
  });

  it('provides inert mocks only for declared platform externals', () => {
    expect(() => checkClient(wrapper(`require('react'); ${exports}`))).not.toThrow();
    expect(() => checkClient(wrapper(`require('node:fs'); ${exports}`)))
      .toThrow('Unexpected browser require: node:fs');
  });
});
