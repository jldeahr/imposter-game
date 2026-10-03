import { describe, expect, it } from 'vitest'
import { GAME_CONFIG } from '../config/gameConfig'
import { addPlayer, getImposterCount, nextRoundIndex, normalizeRoundConfiguration, scoreGuess, scoreVote, selectImposters, tallyVotes } from './gameLogic'
import type { Player } from './types'

const players = (count: number): Player[] => Array.from({ length: count }, (_, index) => ({ id: `player-${index}`, name: `Player ${index}`, joinedAt: index }))

describe('dynamic imposter counts', () => {
  it.each([[1, 1], [11, 1], [12, 2], [16, 2], [17, 3], [25, 3], [26, 3], [100, 3]])('%i players gets %i imposters', (count, expected) => expect(getImposterCount(count)).toBe(expected))
  it.each([0, -1, 2.5])('rejects invalid count %s', (count) => expect(() => getImposterCount(count)).toThrow(RangeError))
  it('accepts more than 25 players', () => expect(addPlayer(players(30), { id: 'extra', name: 'Extra', joinedAt: 0 })).toHaveLength(31))
  it('rejects duplicate IDs and invalid records', () => {
    expect(() => addPlayer(players(2), { id: 'player-0', name: 'Other', joinedAt: 0 })).toThrow(/Duplicate/)
    expect(() => addPlayer(players(2), { id: '', name: 'Other', joinedAt: 0 })).toThrow(/Invalid/)
  })
  it.each([1, 11, 12, 16, 17, 25, 40])('selects the capped unique count for %i players', (count) => {
    const selected = selectImposters(players(count)); expect(selected).toHaveLength(getImposterCount(count)); expect(new Set(selected).size).toBe(selected.length)
  })
})

describe('deterministic vote tallying', () => {
  it('selects one highest vote getter', () => expect(tallyVotes({ a: 'c', b: 'c', c: 'b' }, ['a', 'b', 'c']).leaders).toEqual(['c']))
  it('preserves candidate order for two-way and multi-way ties', () => {
    expect(tallyVotes({ a: 'b', b: 'a' }, ['a', 'b']).leaders).toEqual(['a', 'b'])
    expect(tallyVotes({ a: 'b', b: 'c', c: 'a' }, ['a', 'b', 'c']).leaders).toEqual(['a', 'b', 'c'])
  })
  it('ignores votes for ineligible candidates', () => expect(tallyVotes({ a: 'x', b: 'a' }, ['a', 'b']).totals).toEqual({ a: 1, b: 0 }))
})

describe('rounds and scoring', () => {
  it('progresses through exactly three rounds', () => { expect(GAME_CONFIG.rounds).toHaveLength(3); expect(nextRoundIndex(0)).toBe(1); expect(nextRoundIndex(1)).toBe(2); expect(nextRoundIndex(2)).toBeNull() })
  it('scores votes and guesses without mutation', () => {
    const scores = { group: 0, imposters: 0 }
    expect(scoreVote(scores, true)).toEqual({ group: 1, imposters: 0 })
    expect(scoreVote(scores, false)).toEqual({ group: 0, imposters: 1 })
    expect(scoreGuess(scores, true)).toEqual({ group: 0, imposters: 1 })
    expect(scoreGuess(scores, false)).toEqual(scores)
    expect(scores).toEqual({ group: 0, imposters: 0 })
  })

  it('trims valid round configuration and accepts multi-word words', () => {
    expect(normalizeRoundConfiguration([
      { category: ' Places ', secretWord: ' New York City ' },
      { category: 'Food', secretWord: 'Crème brûlée' },
      { category: 'People', secretWord: 'Ada Lovelace' },
    ])).toEqual([
      { category: 'Places', secretWord: 'New York City' },
      { category: 'Food', secretWord: 'Crème brûlée' },
      { category: 'People', secretWord: 'Ada Lovelace' },
    ])
  })

  it.each([
    [[{ category: ' ', secretWord: 'A' }, { category: 'B', secretWord: 'B' }, { category: 'C', secretWord: 'C' }], /category/],
    [[{ category: 'A', secretWord: ' ' }, { category: 'B', secretWord: 'B' }, { category: 'C', secretWord: 'C' }], /secret word/],
  ])('rejects blank round fields', (rounds, message) => expect(() => normalizeRoundConfiguration(rounds)).toThrow(message))
})
