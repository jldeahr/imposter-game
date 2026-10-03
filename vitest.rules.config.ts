import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/database.rules.test.ts'],
    fileParallelism: false,
  },
})
