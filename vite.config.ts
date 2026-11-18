import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * HiGHS's loader has a fallback `new URL("highs.wasm", import.meta.url)`, which Vite would inline
 * as a 3.5 MB data URL. The app always passes `locateFile` (the wasm is served from public/ and
 * only fetched when someone presses Optimise), so the fallback is replaced with a plain name.
 */
const keepWasmSeparate = (): Plugin => ({
  name: 'keep-highs-wasm-separate',
  enforce: 'pre',
  transform(code, id) {
    if (!id.includes('/highs/build/highs.mjs')) return null;
    return { code: code.replace('new URL("highs.wasm",import.meta.url).href', '"highs.wasm"'), map: null };
  },
});

export default defineConfig({
  base: './',
  plugins: [keepWasmSeparate(), react(), viteSingleFile()],
  worker: { plugins: () => [keepWasmSeparate()] },
  test: { globals: true, environment: 'node' },
});
