import { GAME_CONFIG } from '../config/gameConfig'
import type { Player, RoundConfig, Scores } from './types'

export interface VoteTally { totals: Record<string, number>; leaders: string[]; highestCount: number }

export function getImposterCount(playerCount: number): number {
  if (!Number.isInteger(playerCount) || playerCount < 1) throw new RangeError('Player count must be a positive integer.')
  if (playerCount <= 11) return 1
  if (playerCount <= 16) return 2
  return 3
}

function secureRandomIndex(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new RangeError('Random range must be positive.')
  const maxUint = 0x1_0000_0000
  const limit = maxUint - (maxUint % maxExclusive)
  const value = new Uint32Array(1)
  do crypto.getRandomValues(value)
  while (value[0] >= limit)
  return value[0] % maxExclusive
}

export function selectImposters(players: Player[], count = getImposterCount(players.length)): string[] {
  if (count < 1 || count > players.length) throw new RangeError('Invalid imposter count.')
  const ids = new Set<string>()
  for (const player of players) {
    if (!player.id || !player.name.trim() || ids.has(player.id)) throw new Error('Invalid or duplicate player record.')
    ids.add(player.id)
  }
  const pool = players.map((player) => player.id)
  for (let index = pool.length - 1; index > pool.length - 1 - count; index -= 1) {
    const swapIndex = secureRandomIndex(index + 1)
    ;[pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]]
  }
  return pool.slice(pool.length - count)
}

export function addPlayer(players: Player[], player: Player): Player[] {
  if (!player.id || !player.name.trim()) throw new Error('Invalid player record.')
  if (players.some((item) => item.id === player.id)) throw new Error('Duplicate player ID.')
  return [...players, player]
}

export function normalizeRoundConfiguration(rounds: readonly RoundConfig[]): RoundConfig[] {
  if (rounds.length !== GAME_CONFIG.rounds.length) throw new Error(`Exactly ${GAME_CONFIG.rounds.length} rounds are required.`)
  return rounds.map((round, index) => {
    const category = round.category.trim()
    const secretWord = round.secretWord.trim()
    if (!category) throw new Error(`Round ${index + 1} category is required.`)
    if (!secretWord) throw new Error(`Round ${index + 1} secret word is required.`)
    return { category, secretWord }
  })
}

export function tallyVotes(ballots: Readonly<Record<string, string>>, candidateIds: readonly string[]): VoteTally {
  const totals: Record<string, number> = Object.fromEntries(candidateIds.map((id) => [id, 0]))
  for (const candidateId of Object.values(ballots)) if (candidateId in totals) totals[candidateId] += 1
  const highestCount = Math.max(0, ...Object.values(totals))
  return { totals, highestCount, leaders: highestCount === 0 ? [...candidateIds] : candidateIds.filter((id) => totals[id] === highestCount) }
}

export function nextRoundIndex(currentRoundIndex: number, roundCount = GAME_CONFIG.rounds.length): number | null {
  const next = currentRoundIndex + 1
  return next < roundCount ? next : null
}

export function scoreVote(scores: Scores, correct: boolean): Scores {
  return correct ? { ...scores, group: scores.group + 1 } : { ...scores, imposters: scores.imposters + 1 }
}

export function scoreGuess(scores: Scores, correct: boolean): Scores {
  return correct ? { ...scores, imposters: scores.imposters + 1 } : { ...scores }
}
