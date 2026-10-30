import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { externalClientBundle } from './client-build.js';

const root = new URL('../', import.meta.url);
const pluginId = 'dsh-cot-translation-reader';

/** Import only: never mount the Host plugin or access its services. */
export async function checkHost(entry = new URL('lib/index.js', root)) {
  const host = await import(entry.href);
  assert.equal(host.name, 'cot-translation-reader');
  assert.equal(typeof host.apply, 'function');
  assert.ok(Array.isArray(host.inject));
}

/** Execute the real loader factory, not merely its registration wrapper. */
export function checkClient(source, isExternal = externalClientBundle(pluginId, [], {
  clientEntry: 'src/client/index.ts',
})[1].deps.neverBundle) {
  let registrations = 0;
  let client;
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, pluginId);
          assert.equal(typeof factory, 'function');
          registrations += 1;
          client = factory(specifier => {
            assert.ok(isExternal(specifier), `Unexpected browser require: ${specifier}`);
            // Platform dependencies are inert mocks; local modules must be bundled.
            return Object.freeze({});
          });
        },
      },
    },
  }, { filename: 'lib/client.js', timeout: 2000 });
  assert.equal(registrations, 1);
  assert.equal(client?.name, 'cot-translation-reader');
  assert.equal(typeof client?.apply, 'function');
  assert.equal(typeof client?.createHttpTranslationClient, 'function');
  assert.ok(Array.isArray(client?.inject));
}

export async function checkRuntime() {
  const results = await Promise.allSettled([
    checkHost(),
    readFile(new URL('lib/client.js', root), 'utf8').then(source => checkClient(source)),
  ]);
  const errors = [];
  for (const [index, result] of results.entries()) {
    const label = index === 0 ? 'Host dynamic import (without apply)' : 'Browser module-loader factory (isolated VM)';
    if (result.status === 'fulfilled') console.log(`PASS ${label}`);
    else {
      console.error(`FAIL ${label}: ${result.reason}`);
      errors.push(result.reason);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Built runtime smoke checks failed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await checkRuntime();
}
