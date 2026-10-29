import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { UserConfig } from 'tsdown';

// Vendored copy of the harness client bundle recipe (see tools/client-build.js).
const adapter = fileURLToPath(new URL('./tools/client-build.js', import.meta.url));
if (!existsSync(adapter)) throw new Error('tools/client-build.js is missing.');

const { externalClientBundle } = await import(pathToFileURL(adapter).href);

export default externalClientBundle('dsh-cot-translation-reader', ['src/index.ts'], {
  clientEntry: 'src/client/index.ts',
}) as UserConfig[];
