import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/cookies.test.ts', 'jsdom'],
      ['tests/resource.test.ts', 'jsdom'],
      ['tests/resource-react.test.tsx', 'jsdom'],
      ['tests/store-react.test.ts', 'jsdom'],
    ],
    hookTimeout: 30000,
  },
});
