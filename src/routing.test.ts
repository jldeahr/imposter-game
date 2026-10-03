import { describe, expect, it } from 'vitest'
import { buildJoinUrl } from './routing'

describe('buildJoinUrl', () => {
  it('builds the production GitHub Pages project URL', () => {
    expect(buildJoinUrl('https://jldeahr.github.io', '/imposter-game/', 'abc123')).toBe(
      'https://jldeahr.github.io/imposter-game/#/join/ABC123',
    )
  })

  it('uses the running local origin without losing the project base path', () => {
    expect(buildJoinUrl('http://localhost:5173', '/imposter-game/', 'ROOM1')).toBe(
      'http://localhost:5173/imposter-game/#/join/ROOM1',
    )
  })
})
