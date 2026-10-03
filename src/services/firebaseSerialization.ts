import type { RoundResult } from '../domain/types'

export type StoredRoundResult = Omit<RoundResult, 'imposterGuessCorrect'> & {
  imposterGuessCorrect?: boolean | null
}

/** Realtime Database removes null-valued object properties when persisting. */
export function decodeRoundResult(value: StoredRoundResult | null | undefined): RoundResult | null {
  if (!value) return null
  return {
    ...value,
    imposterGuessCorrect: typeof value.imposterGuessCorrect === 'boolean' ? value.imposterGuessCorrect : null,
  }
}
