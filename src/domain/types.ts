export interface Player { id: string; name: string; joinedAt: number }
export interface Scores { group: number; imposters: number }

export type GamePhase = 'lobby' | 'role-reveal' | 'clue-giving' | 'discussion' | 'voting' | 'runoff-voting' | 'vote-result' | 'imposter-reveal' | 'imposter-word-guess' | 'round-result' | 'complete'

export interface VotingState {
  submittedCount: number
  eligibleVoterCount: number
  waitingPlayerIds: string[]
  candidateIds: string[]
  runoffNumber: number
  manualResolutionRequired: boolean
}

export interface RoundResult {
  selectedPlayerId: string
  selectedWasImposter: boolean
  suspectRevealed: boolean
  imposterGuessCorrect: boolean | null
  groupPoints: number
  imposterPoints: number
}

export interface GameRoom {
  code: string
  players: Player[]
  phase: GamePhase
  currentRoundIndex: number
  imposterIds: string[]
  imposterCount: number
  scores: Scores
  voting: VotingState | null
  roundResult: RoundResult | null
  version: number
  createdAt: number
}

export interface PlayerAssignment { playerId: string; roundNumber: number; category: string; isImposter: boolean; secretWord: string | null }

export interface PlayerGameState {
  code: string
  version: number
  phase: GamePhase
  currentRoundIndex: number
  player: Player
  players: Player[]
  scores: Scores
  assignment: PlayerAssignment | null
  voting: (VotingState & { hasSubmitted: boolean }) | null
  roundResult: RoundResult | null
  revealedImposterIds: string[]
  revealedSecretWord: string | null
}

export type GameStateListener = (state: GameRoom | PlayerGameState) => void
