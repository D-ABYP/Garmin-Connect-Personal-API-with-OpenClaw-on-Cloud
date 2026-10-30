import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/personal/**/*.test.ts', 'src/tools/personal.tools.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'build/**', 'src/client/**'],
  },
});
