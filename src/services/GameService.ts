import type { GameRoom, GameStateListener, PlayerGameState, RoundConfig } from '../domain/types'

export interface GameService {
  initialize(): Promise<void>
  getCurrentPlayerId(): Promise<string>
  createRoom(): Promise<GameRoom>
  getRoom(code: string): Promise<GameRoom | null>
  getGameState(code: string, playerId: string): Promise<PlayerGameState>
  subscribeToGameState(code: string, playerId: string | null, callback: GameStateListener): () => void
  getRoundConfiguration(code: string): Promise<RoundConfig[]>
  updateRoundConfiguration(code: string, rounds: RoundConfig[]): Promise<GameRoom>
  joinRoom(code: string, name: string): Promise<GameRoom>
  removePlayer(code: string, playerId: string): Promise<GameRoom>
  startRound(code: string): Promise<GameRoom>
  startClueGiving(code: string): Promise<GameRoom>
  openDiscussion(code: string): Promise<GameRoom>
  openVoting(code: string): Promise<GameRoom>
  submitVote(code: string, playerId: string, candidateId: string): Promise<PlayerGameState>
  closeVoting(code: string): Promise<GameRoom>
  resolveVote(code: string, candidateId: string): Promise<GameRoom>
  revealVoteResult(code: string): Promise<GameRoom>
  revealImposters(code: string): Promise<GameRoom>
  beginImposterGuess(code: string): Promise<GameRoom>
  recordImposterGuess(code: string, correct: boolean): Promise<GameRoom>
  advanceRound(code: string): Promise<GameRoom>
  finishGame(code: string): Promise<GameRoom>
  resetGame(code: string): Promise<GameRoom>
}
