import { describe, expect, it } from 'vitest'
import { createTimer, resetTimer, startTimer, tickTimer } from './timer'

describe('discussion timer', () => {
  it('starts at two minutes and counts down', () => {
    const started = startTimer(createTimer(120))
    expect(tickTimer(started)).toEqual({ remaining: 119, running: true })
  })

  it('stops at zero', () => {
    expect(tickTimer({ remaining: 1, running: true })).toEqual({ remaining: 0, running: false })
    expect(tickTimer({ remaining: 0, running: false })).toEqual({ remaining: 0, running: false })
  })

  it('resets to the configured duration', () => {
    expect(resetTimer(120)).toEqual({ remaining: 120, running: false })
  })
})
