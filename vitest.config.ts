import { defineConfig } from 'vitest/config';

// Default environment: node. A test that needs a DOM says so: `// @vitest-environment jsdom`.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    },
});
