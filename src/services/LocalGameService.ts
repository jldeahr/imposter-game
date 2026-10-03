import { GAME_CONFIG } from '../config/gameConfig'
import { addPlayer, getImposterCount, nextRoundIndex, scoreGuess, scoreVote, selectImposters, tallyVotes } from '../domain/gameLogic'
import type { GamePhase, GameRoom, GameStateListener, PlayerAssignment, PlayerGameState } from '../domain/types'
import type { GameService } from './GameService'

const STORAGE_KEY = 'imposter-game:demo-room:v2'
const CHANGE_EVENT = 'imposter-game:changed'

interface StoredRoom extends GameRoom { ballots: Record<string, string> }

const clone = <T>(value: T): T => structuredClone(value)
const makeId = (): string => crypto.randomUUID()

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('')
}

function publicRoom(room: StoredRoom): GameRoom {
  const { ballots: _privateBallots, ...safe } = room
  return clone(safe)
}

export class LocalGameService implements GameService {
  private load(): StoredRoom | null {
    const value = localStorage.getItem(STORAGE_KEY)
    return value ? JSON.parse(value) as StoredRoom : null
  }

  private save(room: StoredRoom): GameRoom {
    room.version += 1
    localStorage.setItem(STORAGE_KEY, JSON.stringify(room))
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { code: room.code, version: room.version } }))
    return publicRoom(room)
  }

  private requireRoom(code: string): StoredRoom {
    const room = this.load()
    if (!room || room.code !== code.trim().toUpperCase()) throw new Error('Room not found on this device.')
    return room
  }

  private requirePhase(room: StoredRoom, ...phases: GamePhase[]): void {
    if (!phases.includes(room.phase)) throw new Error(`This action is not available during ${room.phase}.`)
  }

  private assignment(room: StoredRoom, playerId: string): PlayerAssignment {
    const round = GAME_CONFIG.rounds[room.currentRoundIndex]
    if (!round || !room.players.some((player) => player.id === playerId)) throw new Error('Assignment is not available.')
    const isImposter = room.imposterIds.includes(playerId)
    return { playerId, roundNumber: round.number, category: round.category, isImposter, secretWord: isImposter ? null : round.secretWord }
  }

  private playerState(room: StoredRoom, playerId: string): PlayerGameState {
    const player = room.players.find((item) => item.id === playerId)
    if (!player) throw new Error('Player is not in this room.')
    const showImposters = ['imposter-reveal', 'imposter-word-guess', 'round-result', 'complete'].includes(room.phase)
    const showWord = ['round-result', 'complete'].includes(room.phase)
    return {
      code: room.code, version: room.version, phase: room.phase, currentRoundIndex: room.currentRoundIndex,
      player: clone(player), players: clone(room.players), scores: clone(room.scores),
      assignment: room.currentRoundIndex >= 0 && room.phase !== 'complete' ? this.assignment(room, playerId) : null,
      voting: room.voting ? { ...clone(room.voting), hasSubmitted: playerId in room.ballots } : null,
      roundResult: room.roundResult ? clone(room.roundResult) : null,
      revealedImposterIds: showImposters ? [...room.imposterIds] : [],
      revealedSecretWord: showWord ? GAME_CONFIG.rounds[room.currentRoundIndex]?.secretWord ?? null : null,
    }
  }

  private beginRound(room: StoredRoom, index: number): void {
    room.currentRoundIndex = index
    room.imposterCount = getImposterCount(room.players.length)
    room.imposterIds = selectImposters(room.players, room.imposterCount)
    room.phase = 'role-reveal'
    room.ballots = {}
    room.voting = null
    room.roundResult = null
  }

  private finishBallot(room: StoredRoom): void {
    if (!room.voting) throw new Error('Voting is not open.')
    const tally = tallyVotes(room.ballots, room.voting.candidateIds)
    if (tally.leaders.length === 1) {
      const selectedPlayerId = tally.leaders[0]
      room.roundResult = { selectedPlayerId, selectedWasImposter: room.imposterIds.includes(selectedPlayerId), suspectRevealed: false, imposterGuessCorrect: null, groupPoints: 0, imposterPoints: 0 }
      room.phase = 'vote-result'; room.voting = null; room.ballots = {}
      return
    }
    const wasRunoff = room.phase === 'runoff-voting'
    const runoffNumber = wasRunoff ? room.voting.runoffNumber + 1 : 1
    const voters = room.players.filter((player) => tally.leaders.some((id) => id !== player.id)).map((player) => player.id)
    room.ballots = {}
    room.phase = 'runoff-voting'
    room.voting = { submittedCount: 0, eligibleVoterCount: voters.length, waitingPlayerIds: voters, candidateIds: tally.leaders, runoffNumber, manualResolutionRequired: wasRunoff && runoffNumber > GAME_CONFIG.maxRunoffTies }
  }

  async createRoom(): Promise<GameRoom> {
    return this.save({ code: makeCode(), players: [], phase: 'lobby', currentRoundIndex: -1, imposterIds: [], imposterCount: 0, scores: { group: 0, imposters: 0 }, voting: null, roundResult: null, ballots: {}, version: 0, createdAt: Date.now() })
  }

  async getRoom(code: string): Promise<GameRoom | null> {
    const room = this.load()
    return room?.code === code.trim().toUpperCase() ? publicRoom(room) : null
  }

  async getGameState(code: string, playerId: string): Promise<PlayerGameState> { return this.playerState(this.requireRoom(code), playerId) }

  subscribeToGameState(code: string, playerId: string | null, callback: GameStateListener): () => void {
    let lastVersion = -1
    let active = true
    const publish = () => {
      if (!active) return
      const room = this.load()
      if (!room || room.code !== code.toUpperCase() || room.version <= lastVersion) return
      lastVersion = room.version
      callback(playerId ? this.playerState(room, playerId) : publicRoom(room))
    }
    const localListener = () => publish()
    const storageListener = (event: StorageEvent) => { if (event.key === STORAGE_KEY) publish() }
    window.addEventListener(CHANGE_EVENT, localListener)
    window.addEventListener('storage', storageListener)
    queueMicrotask(publish)
    return () => { active = false; window.removeEventListener(CHANGE_EVENT, localListener); window.removeEventListener('storage', storageListener) }
  }

  async joinRoom(code: string, rawName: string): Promise<GameRoom> {
    const room = this.requireRoom(code)
    if (room.phase !== 'lobby' && room.phase !== 'round-result') throw new Error('Players can only join between rounds.')
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 24)
    if (!name) throw new Error('Enter a nickname first.')
    room.players = addPlayer(room.players, { id: makeId(), name, joinedAt: Date.now() })
    return this.save(room)
  }

  async removePlayer(code: string, playerId: string): Promise<GameRoom> {
    const room = this.requireRoom(code)
    if (room.phase !== 'lobby' && room.phase !== 'round-result') throw new Error('Players can only be removed between rounds.')
    if (!room.players.some((player) => player.id === playerId)) throw new Error('Player not found.')
    room.players = room.players.filter((player) => player.id !== playerId)
    return this.save(room)
  }

  async startRound(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'lobby')
    if (!room.players.length) throw new Error('Add at least one demo player first.')
    this.beginRound(room, 0); return this.save(room)
  }

  async startClueGiving(code: string): Promise<GameRoom> { const room = this.requireRoom(code); this.requirePhase(room, 'role-reveal'); room.phase = 'clue-giving'; return this.save(room) }
  async openDiscussion(code: string): Promise<GameRoom> { const room = this.requireRoom(code); this.requirePhase(room, 'clue-giving'); room.phase = 'discussion'; return this.save(room) }

  async openVoting(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'discussion')
    const ids = room.players.map((player) => player.id)
    room.phase = 'voting'; room.ballots = {}; room.voting = { submittedCount: 0, eligibleVoterCount: ids.length, waitingPlayerIds: ids, candidateIds: ids, runoffNumber: 0, manualResolutionRequired: false }
    return this.save(room)
  }

  async submitVote(code: string, playerId: string, candidateId: string): Promise<PlayerGameState> {
    const room = this.requireRoom(code); this.requirePhase(room, 'voting', 'runoff-voting')
    if (!room.voting || room.voting.manualResolutionRequired) throw new Error('Voting is closed for manual resolution.')
    if (!room.players.some((player) => player.id === playerId)) throw new Error('Voter is not in this room.')
    if (playerId in room.ballots) throw new Error('Your vote has already been submitted.')
    if (candidateId === playerId) throw new Error('You cannot vote for yourself.')
    if (!room.voting.candidateIds.includes(candidateId)) throw new Error('That player is not eligible in this vote.')
    room.ballots[playerId] = candidateId
    room.voting.submittedCount = Object.keys(room.ballots).length
    room.voting.waitingPlayerIds = room.voting.waitingPlayerIds.filter((id) => id !== playerId)
    if (room.voting.submittedCount >= room.voting.eligibleVoterCount) this.finishBallot(room)
    this.save(room)
    return this.playerState(room, playerId)
  }

  async closeVoting(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'voting', 'runoff-voting')
    if (!Object.keys(room.ballots).length) throw new Error('At least one vote is required.')
    this.finishBallot(room); return this.save(room)
  }

  async resolveVote(code: string, candidateId: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'runoff-voting')
    if (!room.voting?.manualResolutionRequired) throw new Error('Manual resolution is not available yet.')
    if (!room.voting.candidateIds.includes(candidateId)) throw new Error('Choose one of the tied players.')
    room.roundResult = { selectedPlayerId: candidateId, selectedWasImposter: room.imposterIds.includes(candidateId), suspectRevealed: false, imposterGuessCorrect: null, groupPoints: 0, imposterPoints: 0 }
    room.phase = 'vote-result'; room.voting = null; room.ballots = {}; return this.save(room)
  }

  async revealVoteResult(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'vote-result')
    if (!room.roundResult || room.roundResult.suspectRevealed) throw new Error('Vote result has already been scored.')
    room.roundResult.suspectRevealed = true
    room.roundResult.groupPoints = room.roundResult.selectedWasImposter ? 1 : 0
    room.roundResult.imposterPoints = room.roundResult.selectedWasImposter ? 0 : 1
    room.scores = scoreVote(room.scores, room.roundResult.selectedWasImposter)
    return this.save(room)
  }

  async revealImposters(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'vote-result')
    if (!room.roundResult?.suspectRevealed) throw new Error('Reveal the selected player result first.')
    room.phase = 'imposter-reveal'; return this.save(room)
  }

  async beginImposterGuess(code: string): Promise<GameRoom> { const room = this.requireRoom(code); this.requirePhase(room, 'imposter-reveal'); room.phase = 'imposter-word-guess'; return this.save(room) }

  async recordImposterGuess(code: string, correct: boolean): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'imposter-word-guess')
    if (!room.roundResult || room.roundResult.imposterGuessCorrect !== null) throw new Error('The word guess has already been recorded.')
    room.roundResult.imposterGuessCorrect = correct
    if (correct) room.roundResult.imposterPoints += 1
    room.scores = scoreGuess(room.scores, correct); room.phase = 'round-result'; return this.save(room)
  }

  async advanceRound(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'round-result')
    const next = nextRoundIndex(room.currentRoundIndex)
    if (next === null) return this.finishGame(code)
    this.beginRound(room, next); return this.save(room)
  }

  async finishGame(code: string): Promise<GameRoom> { const room = this.requireRoom(code); this.requirePhase(room, 'round-result'); room.phase = 'complete'; room.ballots = {}; room.voting = null; return this.save(room) }

  async resetGame(code: string): Promise<GameRoom> {
    const room = this.requireRoom(code); this.requirePhase(room, 'complete')
    room.phase = 'lobby'; room.currentRoundIndex = -1; room.imposterIds = []; room.imposterCount = 0; room.scores = { group: 0, imposters: 0 }; room.ballots = {}; room.voting = null; room.roundResult = null
    return this.save(room)
  }
}
