import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.{test,bench,spec}.?(c|m)[jt]s?(x)'],
  },
});
