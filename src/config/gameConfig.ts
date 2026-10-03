import type { RoundConfig } from '../domain/types'

export const DEFAULT_ROUNDS: readonly RoundConfig[] = [
  { category: 'Church', secretWord: 'Bible' },
  { category: 'Holiday', secretWord: 'Christmas' },
  { category: 'People We Know', secretWord: 'Adam Ingle' },
]

export const GAME_CONFIG = {
  discussionSeconds: 120,
  maxRunoffTies: 3,
  rounds: DEFAULT_ROUNDS,
} as const
