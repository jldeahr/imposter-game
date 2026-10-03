import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/imposter-game/',
  test: {
    environment: 'node',
  },
})
