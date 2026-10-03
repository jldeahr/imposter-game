import { describe, expect, it } from 'vitest'
import { decodeRoundResult } from './firebaseSerialization'

const storedResult = {
  selectedPlayerId: 'player-2',
  selectedWasImposter: true,
  suspectRevealed: true,
  groupPoints: 1,
  imposterPoints: 0,
}

describe('decodeRoundResult', () => {
  it('restores a missing pending guess to null after Firebase serialization', () => {
    expect(decodeRoundResult(storedResult)?.imposterGuessCorrect).toBeNull()
  })

  it.each([true, false])('preserves a recorded guess of %s', (guess) => {
    expect(decodeRoundResult({ ...storedResult, imposterGuessCorrect: guess })?.imposterGuessCorrect).toBe(guess)
  })
})
