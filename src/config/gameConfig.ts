export interface RoundConfig {
  number: number
  category: string
  secretWord: string
}

export const GAME_CONFIG = {
  discussionSeconds: 120,
  maxRunoffTies: 3,
  rounds: [
    { number: 1, category: 'Church', secretWord: 'Bible' },
    { number: 2, category: 'Holiday', secretWord: 'Christmas' },
    { number: 3, category: 'People We Know', secretWord: 'Adam Ingle' },
  ] satisfies RoundConfig[],
} as const
