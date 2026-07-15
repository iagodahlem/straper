import { defineConfig } from 'vitest/config'

const setupFiles = ['tests/setup/fake-home.ts']

export default defineConfig({
  test: {
    globalSetup: ['tests/setup/global-home.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/__tests__/**/*.test.ts'],
          setupFiles,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          setupFiles,
        },
      },
    ],
  },
})
