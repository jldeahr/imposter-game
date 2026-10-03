import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/imposter-game/',
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, 'tests/database.rules.test.ts'],
  },
})
