import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// NestJS relies on `emitDecoratorMetadata` for constructor injection. Vitest's default
// esbuild transform does not emit it, so DI silently breaks in tests. SWC does.
export default defineConfig({
  test: { globals: true, environment: 'node', root: '.' },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
