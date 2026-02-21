import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['tests/cloud/**', 'node_modules/**', 'dist/**'],
  },
});
