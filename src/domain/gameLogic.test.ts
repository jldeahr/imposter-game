import { describe, expect, it } from 'vitest'
import { GAME_CONFIG } from '../config/gameConfig'
import { addPlayer, applyScore, getImposterCount, isGameComplete, nextRoundIndex, selectImposters } from './gameLogic'
import type { GameRoom, Player } from './types'

const players = (count: number): Player[] => Array.from({ length: count }, (_, index) => ({
  id: `player-${index}`,
  name: `Player ${index}`,
  joinedAt: index,
}))

describe('getImposterCount', () => {
  it.each([
    [1, 1], [11, 1], [12, 2], [16, 2], [17, 3], [25, 3],
  ])('returns %i imposters for %i players', (playerCount, expected) => {
    expect(getImposterCount(playerCount)).toBe(expected)
  })

  it.each([0, 26, -1, 2.5])('rejects invalid player count %s', (count) => {
    expect(() => getImposterCount(count)).toThrow(RangeError)
  })
})

describe('room limits and assignments', () => {
  it('caps rooms at 25 players', () => {
    expect(() => addPlayer(players(25), { id: 'extra', name: 'Extra', joinedAt: 0 })).toThrow(/full/)
  })

  it.each([1, 11, 12, 16, 17, 25])('selects the correct number of unique imposters for %i players', (count) => {
    const selected = selectImposters(players(count))
    expect(selected).toHaveLength(getImposterCount(count))
    expect(new Set(selected).size).toBe(selected.length)
    expect(selected.every((id) => players(count).some((player) => player.id === id))).toBe(true)
  })
})

describe('round progression', () => {
  it('progresses through exactly three rounds', () => {
    expect(GAME_CONFIG.rounds).toHaveLength(3)
    expect(nextRoundIndex(0)).toBe(1)
    expect(nextRoundIndex(1)).toBe(2)
    expect(nextRoundIndex(2)).toBeNull()
  })

  it('recognizes completion only after round three', () => {
    expect(isGameComplete({ status: 'round', currentRoundIndex: 2 })).toBe(false)
    expect(isGameComplete({ status: 'complete', currentRoundIndex: 2 })).toBe(true)
  })
})

describe('scoring', () => {
  it('awards the group for finding an imposter', () => {
    expect(applyScore({ group: 0, imposters: 0 }, 'group-found-imposter')).toEqual({ group: 1, imposters: 0 })
  })

  it('awards imposters for either scoring event', () => {
    const afterVote = applyScore({ group: 0, imposters: 0 }, 'group-picked-normal')
    expect(applyScore(afterVote, 'imposters-guessed-word')).toEqual({ group: 0, imposters: 2 })
  })

  it('does not mutate the original scores', () => {
    const scores: GameRoom['scores'] = { group: 2, imposters: 1 }
    applyScore(scores, 'group-found-imposter')
    expect(scores).toEqual({ group: 2, imposters: 1 })
  })
})
