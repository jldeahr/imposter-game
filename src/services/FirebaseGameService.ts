import { get, onValue, ref, remove, runTransaction, set, update, type Unsubscribe } from 'firebase/database'
import { DEFAULT_ROUNDS, GAME_CONFIG } from '../config/gameConfig'
import { getImposterCount, nextRoundIndex, normalizeRoundConfiguration, scoreGuess, scoreVote, selectImposters, tallyVotes } from '../domain/gameLogic'
import type { GamePhase, GameRoom, GameStateListener, Player, PlayerAssignment, PlayerGameState, RoundConfig, RoundResult, Scores, VotingState } from '../domain/types'
import type { GameService } from './GameService'
import { decodeRoundResult, type StoredRoundResult } from './firebaseSerialization'
import { ensureAnonymousUser, firebaseDatabase } from './firebase'

type JsonRecord = Record<string, unknown>

interface PublicVoting {
  submittedCount: number
  eligibleVoterCount: number
  waitingPlayerIds: Record<string, boolean>
  candidateIds: Record<string, boolean>
  runoffNumber: number
  manualResolutionRequired: boolean
  votingRound: string
}

interface PublicState {
  phase: GamePhase
  currentRoundIndex: number
  category: string
  playerCount: number
  imposterCount: number
  configurationSaved: boolean
  configurationLocked: boolean
  scores: Scores
  voting?: PublicVoting | null
  roundResult?: StoredRoundResult | null
  revealedImposterIds?: Record<string, boolean> | null
  revealedSecretWord?: string | null
  stateVersion: number
}

interface HostState {
  imposterIds?: Record<string, boolean>
  roundResult?: StoredRoundResult | null
}

interface AssignmentRecord {
  roundIndex: number
  category: string
  role: 'normal' | 'imposter'
  secretWord?: string
}

interface VoteRecord { candidateUid: string; votingRound: string }

const roomPath = (code: string, child = ''): string => `rooms/${code}${child ? `/${child}` : ''}`
const normalizeCode = (code: string): string => code.trim().toUpperCase()
const objectIds = (value: Record<string, boolean> | null | undefined): string[] => value ? Object.keys(value).filter((key) => value[key]) : []
const idObject = (ids: readonly string[]): Record<string, boolean> => Object.fromEntries(ids.map((id) => [id, true]))
const clone = <T>(value: T): T => structuredClone(value)

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join('')
}

function toPlayers(value: Record<string, { displayName?: string; joinedAt?: number; active?: boolean }> | null): Player[] {
  if (!value) return []
  return Object.entries(value)
    .filter(([, player]) => player.active !== false && typeof player.displayName === 'string')
    .map(([id, player]) => ({ id, name: player.displayName!.trim(), joinedAt: Number(player.joinedAt ?? 0) }))
    .sort((a, b) => a.joinedAt - b.joinedAt)
}

function toVoting(value: PublicVoting | null | undefined): VotingState | null {
  if (!value) return null
  return {
    submittedCount: Number(value.submittedCount ?? 0),
    eligibleVoterCount: Number(value.eligibleVoterCount ?? 0),
    waitingPlayerIds: objectIds(value.waitingPlayerIds),
    candidateIds: objectIds(value.candidateIds),
    runoffNumber: Number(value.runoffNumber ?? 0),
    manualResolutionRequired: value.manualResolutionRequired === true,
  }
}

export class FirebaseGameService implements GameService {
  private voteSyncing = new Set<string>()
  private voteSyncPending = new Set<string>()

  async initialize(): Promise<void> { await ensureAnonymousUser() }
  async getCurrentPlayerId(): Promise<string> { return (await ensureAnonymousUser()).uid }

  private async requireMeta(code: string): Promise<{ hostUid: string; createdAt: number }> {
    const snapshot = await get(ref(firebaseDatabase, roomPath(normalizeCode(code), 'meta')))
    if (!snapshot.exists()) throw new Error('Room not found.')
    return snapshot.val() as { hostUid: string; createdAt: number }
  }

  private async requireHost(code: string): Promise<{ uid: string; meta: { hostUid: string; createdAt: number } }> {
    const uid = await this.getCurrentPlayerId()
    const meta = await this.requireMeta(code)
    if (meta.hostUid !== uid) throw new Error('Only the room host can do that.')
    return { uid, meta }
  }

  private async readPlayers(code: string): Promise<Player[]> {
    const snapshot = await get(ref(firebaseDatabase, roomPath(code, 'players')))
    return toPlayers(snapshot.val() as Record<string, { displayName?: string; joinedAt?: number; active?: boolean }> | null)
  }

  private async readPublic(code: string): Promise<PublicState> {
    const snapshot = await get(ref(firebaseDatabase, roomPath(code, 'public')))
    if (!snapshot.exists()) throw new Error('Room is unavailable.')
    return snapshot.val() as PublicState
  }

  private async hostRoom(code: string): Promise<GameRoom> {
    code = normalizeCode(code)
    const { meta } = await this.requireHost(code)
    const [publicSnapshot, players, configSnapshot, hostSnapshot] = await Promise.all([
      this.readPublic(code),
      this.readPlayers(code),
      get(ref(firebaseDatabase, roomPath(code, 'config/rounds'))),
      get(ref(firebaseDatabase, roomPath(code, 'hostState'))),
    ])
    const rounds = normalizeRoundConfiguration(Object.values(configSnapshot.val() as Record<string, RoundConfig> ?? {}))
    const hostState = (hostSnapshot.val() ?? {}) as HostState
    return {
      code,
      players,
      phase: publicSnapshot.phase,
      currentRoundIndex: Number(publicSnapshot.currentRoundIndex),
      imposterIds: objectIds(hostState.imposterIds),
      imposterCount: Number(publicSnapshot.imposterCount ?? 0),
      scores: publicSnapshot.scores ?? { group: 0, imposters: 0 },
      rounds,
      configurationSaved: publicSnapshot.configurationSaved === true,
      configurationLocked: publicSnapshot.configurationLocked === true,
      voting: toVoting(publicSnapshot.voting),
      roundResult: decodeRoundResult(hostState.roundResult ?? publicSnapshot.roundResult),
      version: Number(publicSnapshot.stateVersion ?? 0),
      createdAt: Number(meta.createdAt),
    }
  }

  async createRoom(): Promise<GameRoom> {
    const user = await ensureAnonymousUser()
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = makeCode()
      const metaRef = ref(firebaseDatabase, roomPath(code, 'meta'))
      if ((await get(metaRef)).exists()) continue
      const createdAt = Date.now()
      try {
        await set(metaRef, { hostUid: user.uid, createdAt })
        const rounds = Object.fromEntries(DEFAULT_ROUNDS.map((round, index) => [index, { ...round }]))
        await update(ref(firebaseDatabase), {
          [roomPath(code, 'joinInfo')]: { phase: 'lobby', createdAt },
          [roomPath(code, 'public')]: { phase: 'lobby', currentRoundIndex: -1, category: '', playerCount: 0, imposterCount: 0, configurationSaved: false, configurationLocked: false, scores: { group: 0, imposters: 0 }, stateVersion: 1 },
          [roomPath(code, 'config/rounds')]: rounds,
          [roomPath(code, 'hostState')]: { imposterIds: {}, roundResult: null },
        })
        return this.hostRoom(code)
      } catch (error) {
        await remove(metaRef).catch(() => undefined)
        throw error
      }
    }
    throw new Error('Could not create a unique room. Please try again.')
  }

  async getRoom(code: string): Promise<GameRoom | null> {
    code = normalizeCode(code)
    const meta = await get(ref(firebaseDatabase, roomPath(code, 'meta')))
    if (!meta.exists()) return null
    return this.hostRoom(code)
  }

  async getRoundConfiguration(code: string): Promise<RoundConfig[]> {
    code = normalizeCode(code)
    await this.requireHost(code)
    const snapshot = await get(ref(firebaseDatabase, roomPath(code, 'config/rounds')))
    return normalizeRoundConfiguration(Object.values(snapshot.val() as Record<string, RoundConfig> ?? {}))
  }

  async updateRoundConfiguration(code: string, rounds: RoundConfig[]): Promise<GameRoom> {
    code = normalizeCode(code)
    await this.requireHost(code)
    const publicState = await this.readPublic(code)
    if (publicState.phase !== 'lobby' || publicState.configurationLocked) throw new Error('Game setup is locked after play begins.')
    const normalized = normalizeRoundConfiguration(rounds)
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'config/rounds')]: Object.fromEntries(normalized.map((round, index) => [index, round])),
      [roomPath(code, 'public/configurationSaved')]: true,
      [roomPath(code, 'public/stateVersion')]: publicState.stateVersion + 1,
    })
    return this.hostRoom(code)
  }

  async joinRoom(rawCode: string, rawName: string): Promise<GameRoom> {
    const code = normalizeCode(rawCode)
    const user = await ensureAnonymousUser()
    const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 24)
    if (!name) throw new Error('Enter a nickname first.')
    const joinSnapshot = await get(ref(firebaseDatabase, roomPath(code, 'joinInfo')))
    if (!joinSnapshot.exists()) throw new Error('Room not found.')
    const phase = String(joinSnapshot.child('phase').val())
    if (phase !== 'lobby' && phase !== 'round-result') throw new Error('This room is closed to new players right now.')
    const playerRef = ref(firebaseDatabase, roomPath(code, `players/${user.uid}`))
    // A transaction reads before writing, but non-members intentionally cannot
    // read the player roster. A direct write lets the join rule validate the
    // new member without exposing existing player data first.
    await set(playerRef, { displayName: name, joinedAt: Date.now(), active: true })
    const [publicState, players] = await Promise.all([this.readPublic(code), this.readPlayers(code)])
    return {
      code, players, phase: publicState.phase, currentRoundIndex: publicState.currentRoundIndex, imposterIds: [], imposterCount: publicState.imposterCount,
      scores: publicState.scores, rounds: [], configurationSaved: publicState.configurationSaved, configurationLocked: publicState.configurationLocked,
      voting: toVoting(publicState.voting), roundResult: decodeRoundResult(publicState.roundResult), version: publicState.stateVersion, createdAt: Number(joinSnapshot.child('createdAt').val() ?? 0),
    }
  }

  async removePlayer(code: string, playerId: string): Promise<GameRoom> {
    code = normalizeCode(code); await this.requireHost(code)
    const publicState = await this.readPublic(code)
    if (publicState.phase !== 'lobby' && publicState.phase !== 'round-result') throw new Error('Players can only be removed between rounds.')
    await update(ref(firebaseDatabase), {
      [roomPath(code, `players/${playerId}/active`)]: false,
      [roomPath(code, `assignments/${playerId}`)]: null,
      [roomPath(code, `votes/${playerId}`)]: null,
      [roomPath(code, 'public/playerCount')]: Math.max(0, publicState.playerCount - 1),
      [roomPath(code, 'public/stateVersion')]: publicState.stateVersion + 1,
    })
    return this.hostRoom(code)
  }

  private async startRoundAt(code: string, roundIndex: number): Promise<GameRoom> {
    await this.requireHost(code)
    const [room, players] = await Promise.all([this.hostRoom(code), this.readPlayers(code)])
    if (!players.length) throw new Error('At least one active player is required.')
    if (!room.configurationSaved) throw new Error('Save the game setup before starting.')
    const round = room.rounds[roundIndex]
    if (!round) throw new Error('Round configuration is missing.')
    const imposterCount = getImposterCount(players.length)
    const imposterIds = selectImposters(players, imposterCount)
    const imposterSet = new Set(imposterIds)
    const assignments = Object.fromEntries(players.map((player) => [player.id, imposterSet.has(player.id)
      ? { roundIndex, category: round.category, role: 'imposter' }
      : { roundIndex, category: round.category, role: 'normal', secretWord: round.secretWord }]))
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'assignments')]: assignments,
      [roomPath(code, 'votes')]: null,
      [roomPath(code, 'hostState')]: { imposterIds: idObject(imposterIds), roundResult: null },
      [roomPath(code, 'public/phase')]: 'role-reveal',
      [roomPath(code, 'public/currentRoundIndex')]: roundIndex,
      [roomPath(code, 'public/category')]: round.category,
      [roomPath(code, 'public/playerCount')]: players.length,
      [roomPath(code, 'public/imposterCount')]: imposterCount,
      [roomPath(code, 'public/configurationLocked')]: true,
      [roomPath(code, 'public/voting')]: null,
      [roomPath(code, 'public/roundResult')]: null,
      [roomPath(code, 'public/revealedImposterIds')]: null,
      [roomPath(code, 'public/revealedSecretWord')]: null,
      [roomPath(code, 'public/stateVersion')]: room.version + 1,
      [roomPath(code, 'joinInfo/phase')]: 'role-reveal',
    })
    return this.hostRoom(code)
  }

  async startRound(code: string): Promise<GameRoom> {
    code = normalizeCode(code)
    const state = await this.readPublic(code)
    if (state.phase !== 'lobby') throw new Error('The game has already started.')
    return this.startRoundAt(code, 0)
  }

  private async setPhase(code: string, expected: GamePhase, phase: GamePhase, extra: JsonRecord = {}): Promise<GameRoom> {
    code = normalizeCode(code); await this.requireHost(code)
    const state = await this.readPublic(code)
    if (state.phase !== expected) throw new Error(`This action is not available during ${state.phase}.`)
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'public/phase')]: phase,
      [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1,
      [roomPath(code, 'joinInfo/phase')]: phase,
      ...extra,
    })
    return this.hostRoom(code)
  }

  async startClueGiving(code: string): Promise<GameRoom> { return this.setPhase(code, 'role-reveal', 'clue-giving') }
  async openDiscussion(code: string): Promise<GameRoom> { return this.setPhase(code, 'clue-giving', 'discussion') }

  async openVoting(code: string): Promise<GameRoom> {
    code = normalizeCode(code); await this.requireHost(code)
    const [state, players] = await Promise.all([this.readPublic(code), this.readPlayers(code)])
    if (state.phase !== 'discussion') throw new Error('Voting can only open during discussion.')
    const ids = players.map((player) => player.id)
    const votingRound = `${state.currentRoundIndex}:0`
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'votes')]: null,
      [roomPath(code, 'public/phase')]: 'voting',
      [roomPath(code, 'public/voting')]: { submittedCount: 0, eligibleVoterCount: ids.length, waitingPlayerIds: idObject(ids), candidateIds: idObject(ids), runoffNumber: 0, manualResolutionRequired: false, votingRound },
      [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1,
      [roomPath(code, 'joinInfo/phase')]: 'voting',
    })
    return this.hostRoom(code)
  }

  async submitVote(code: string, playerId: string, candidateId: string): Promise<PlayerGameState> {
    code = normalizeCode(code)
    const uid = await this.getCurrentPlayerId()
    if (uid !== playerId) throw new Error('You can only submit your own vote.')
    const state = await this.readPublic(code)
    if ((state.phase !== 'voting' && state.phase !== 'runoff-voting') || !state.voting || state.voting.manualResolutionRequired) throw new Error('Voting is not open.')
    if (candidateId === uid) throw new Error('You cannot vote for yourself.')
    if (!state.voting.candidateIds?.[candidateId]) throw new Error('That player is not eligible in this vote.')
    const result = await runTransaction(ref(firebaseDatabase, roomPath(code, `votes/${uid}`)), (current: VoteRecord | null) => current ?? { candidateUid: candidateId, votingRound: state.voting!.votingRound }, { applyLocally: false })
    if (!result.committed || result.snapshot.val()?.candidateUid !== candidateId) throw new Error('Your vote has already been submitted.')
    return this.getGameState(code, uid)
  }

  private async readVotes(code: string): Promise<Record<string, VoteRecord>> {
    const snapshot = await get(ref(firebaseDatabase, roomPath(code, 'votes')))
    return (snapshot.val() ?? {}) as Record<string, VoteRecord>
  }

  private async finishBallot(code: string): Promise<void> {
    const [state, players, votes] = await Promise.all([this.readPublic(code), this.readPlayers(code), this.readVotes(code)])
    if ((state.phase !== 'voting' && state.phase !== 'runoff-voting') || !state.voting) throw new Error('Voting is not open.')
    const playerIds = new Set(players.map((player) => player.id))
    const candidates = objectIds(state.voting.candidateIds)
    const valid = Object.fromEntries(Object.entries(votes).filter(([voter, vote]) => playerIds.has(voter) && vote.votingRound === state.voting!.votingRound && candidates.includes(vote.candidateUid) && voter !== vote.candidateUid).map(([voter, vote]) => [voter, vote.candidateUid]))
    if (!Object.keys(valid).length) throw new Error('At least one valid vote is required.')
    const tally = tallyVotes(valid, candidates)
    if (tally.leaders.length === 1) {
      const selectedPlayerId = tally.leaders[0]
      const hostSnapshot = await get(ref(firebaseDatabase, roomPath(code, 'hostState')))
      const hostState = (hostSnapshot.val() ?? {}) as HostState
      const wasImposter = objectIds(hostState.imposterIds).includes(selectedPlayerId)
      const result: RoundResult = { selectedPlayerId, selectedWasImposter: wasImposter, suspectRevealed: false, imposterGuessCorrect: null, groupPoints: 0, imposterPoints: 0 }
      await update(ref(firebaseDatabase), {
        [roomPath(code, 'votes')]: null,
        [roomPath(code, 'hostState/roundResult')]: result,
        [roomPath(code, 'public/phase')]: 'vote-result',
        [roomPath(code, 'public/voting')]: null,
        [roomPath(code, 'public/roundResult')]: { ...result, selectedWasImposter: false },
        [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1,
        [roomPath(code, 'joinInfo/phase')]: 'vote-result',
      })
      return
    }
    const wasRunoff = state.phase === 'runoff-voting'
    const runoffNumber = wasRunoff ? state.voting.runoffNumber + 1 : 1
    const voters = players.filter((player) => tally.leaders.some((id) => id !== player.id)).map((player) => player.id)
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'votes')]: null,
      [roomPath(code, 'public/phase')]: 'runoff-voting',
      [roomPath(code, 'public/voting')]: { submittedCount: 0, eligibleVoterCount: voters.length, waitingPlayerIds: idObject(voters), candidateIds: idObject(tally.leaders), runoffNumber, manualResolutionRequired: wasRunoff && runoffNumber > GAME_CONFIG.maxRunoffTies, votingRound: `${state.currentRoundIndex}:${runoffNumber}` },
      [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1,
      [roomPath(code, 'joinInfo/phase')]: 'runoff-voting',
    })
  }

  async closeVoting(code: string): Promise<GameRoom> { code = normalizeCode(code); await this.requireHost(code); await this.finishBallot(code); return this.hostRoom(code) }

  async resolveVote(code: string, candidateId: string): Promise<GameRoom> {
    code = normalizeCode(code); await this.requireHost(code)
    const [state, hostSnapshot] = await Promise.all([this.readPublic(code), get(ref(firebaseDatabase, roomPath(code, 'hostState')))])
    if (state.phase !== 'runoff-voting' || !state.voting?.manualResolutionRequired) throw new Error('Manual resolution is not available.')
    if (!state.voting.candidateIds[candidateId]) throw new Error('Choose one of the tied players.')
    const hostState = (hostSnapshot.val() ?? {}) as HostState
    const result: RoundResult = { selectedPlayerId: candidateId, selectedWasImposter: objectIds(hostState.imposterIds).includes(candidateId), suspectRevealed: false, imposterGuessCorrect: null, groupPoints: 0, imposterPoints: 0 }
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'votes')]: null, [roomPath(code, 'hostState/roundResult')]: result,
      [roomPath(code, 'public/phase')]: 'vote-result', [roomPath(code, 'public/voting')]: null,
      [roomPath(code, 'public/roundResult')]: { ...result, selectedWasImposter: false },
      [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1, [roomPath(code, 'joinInfo/phase')]: 'vote-result',
    })
    return this.hostRoom(code)
  }

  async revealVoteResult(code: string): Promise<GameRoom> {
    code = normalizeCode(code); await this.requireHost(code)
    const room = await this.hostRoom(code)
    if (room.phase !== 'vote-result' || !room.roundResult || room.roundResult.suspectRevealed) throw new Error('Vote result has already been resolved.')
    const result = clone(room.roundResult)
    result.suspectRevealed = true; result.groupPoints = result.selectedWasImposter ? 1 : 0; result.imposterPoints = result.selectedWasImposter ? 0 : 1
    const scores = scoreVote(room.scores, result.selectedWasImposter)
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'hostState/roundResult')]: result, [roomPath(code, 'public/roundResult')]: result,
      [roomPath(code, 'public/scores')]: scores, [roomPath(code, 'public/stateVersion')]: room.version + 1,
    })
    return this.hostRoom(code)
  }

  async revealImposters(code: string): Promise<GameRoom> {
    code = normalizeCode(code); const room = await this.hostRoom(code)
    if (room.phase !== 'vote-result' || !room.roundResult?.suspectRevealed) throw new Error('Reveal the selected player result first.')
    return this.setPhase(code, 'vote-result', 'imposter-reveal', { [roomPath(code, 'public/revealedImposterIds')]: idObject(room.imposterIds) })
  }

  async beginImposterGuess(code: string): Promise<GameRoom> { return this.setPhase(normalizeCode(code), 'imposter-reveal', 'imposter-word-guess') }

  async recordImposterGuess(code: string, correct: boolean): Promise<GameRoom> {
    code = normalizeCode(code); const room = await this.hostRoom(code)
    if (room.phase !== 'imposter-word-guess' || !room.roundResult || room.roundResult.imposterGuessCorrect !== null) throw new Error('The word guess has already been recorded.')
    const result = clone(room.roundResult); result.imposterGuessCorrect = correct; if (correct) result.imposterPoints += 1
    const scores = scoreGuess(room.scores, correct)
    const word = room.rounds[room.currentRoundIndex].secretWord
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'hostState/roundResult')]: result, [roomPath(code, 'public/roundResult')]: result,
      [roomPath(code, 'public/scores')]: scores, [roomPath(code, 'public/phase')]: 'round-result',
      [roomPath(code, 'public/revealedSecretWord')]: word, [roomPath(code, 'public/stateVersion')]: room.version + 1,
      [roomPath(code, 'joinInfo/phase')]: 'round-result',
    })
    return this.hostRoom(code)
  }

  async advanceRound(code: string): Promise<GameRoom> {
    code = normalizeCode(code); const room = await this.hostRoom(code)
    if (room.phase !== 'round-result') throw new Error('Finish the round before advancing.')
    const next = nextRoundIndex(room.currentRoundIndex, room.rounds.length)
    if (next === null) return this.finishGame(code)
    return this.startRoundAt(code, next)
  }

  async finishGame(code: string): Promise<GameRoom> {
    code = normalizeCode(code)
    return this.setPhase(code, 'round-result', 'complete', { [roomPath(code, 'votes')]: null, [roomPath(code, 'assignments')]: null, [roomPath(code, 'public/voting')]: null })
  }

  async resetGame(code: string): Promise<GameRoom> {
    code = normalizeCode(code); const room = await this.hostRoom(code)
    if (room.phase !== 'complete') throw new Error('Only a completed game can be reset.')
    await update(ref(firebaseDatabase), {
      [roomPath(code, 'assignments')]: null, [roomPath(code, 'votes')]: null,
      [roomPath(code, 'hostState')]: { imposterIds: {}, roundResult: null },
      [roomPath(code, 'public/phase')]: 'lobby', [roomPath(code, 'public/currentRoundIndex')]: -1,
      [roomPath(code, 'public/category')]: '', [roomPath(code, 'public/imposterCount')]: 0,
      [roomPath(code, 'public/configurationLocked')]: false, [roomPath(code, 'public/scores')]: { group: 0, imposters: 0 },
      [roomPath(code, 'public/voting')]: null, [roomPath(code, 'public/roundResult')]: null,
      [roomPath(code, 'public/revealedImposterIds')]: null, [roomPath(code, 'public/revealedSecretWord')]: null,
      [roomPath(code, 'public/stateVersion')]: room.version + 1, [roomPath(code, 'joinInfo/phase')]: 'lobby',
    })
    return this.hostRoom(code)
  }

  async getGameState(code: string, playerId: string): Promise<PlayerGameState> {
    code = normalizeCode(code)
    const uid = await this.getCurrentPlayerId()
    if (uid !== playerId) throw new Error('You can only load your own player state.')
    const [publicState, players, assignmentSnapshot, voteSnapshot] = await Promise.all([
      this.readPublic(code), this.readPlayers(code), get(ref(firebaseDatabase, roomPath(code, `assignments/${uid}`))), get(ref(firebaseDatabase, roomPath(code, `votes/${uid}`))),
    ])
    const player = players.find((item) => item.id === uid)
    if (!player) throw new Error('You were removed from this room.')
    const assignmentRecord = assignmentSnapshot.val() as AssignmentRecord | null
    const assignmentAllowed = ['role-reveal', 'clue-giving', 'discussion', 'voting', 'runoff-voting'].includes(publicState.phase) && assignmentRecord?.roundIndex === publicState.currentRoundIndex
    const assignment: PlayerAssignment | null = assignmentAllowed && assignmentRecord ? {
      playerId: uid, roundNumber: publicState.currentRoundIndex + 1, category: assignmentRecord.category,
      isImposter: assignmentRecord.role === 'imposter', secretWord: assignmentRecord.role === 'normal' ? assignmentRecord.secretWord ?? null : null,
    } : null
    return {
      code, version: publicState.stateVersion, phase: publicState.phase, currentRoundIndex: publicState.currentRoundIndex,
      player, players, scores: publicState.scores ?? { group: 0, imposters: 0 }, assignment,
      voting: publicState.voting ? { ...toVoting(publicState.voting)!, hasSubmitted: voteSnapshot.exists() && voteSnapshot.child('votingRound').val() === publicState.voting.votingRound } : null,
      roundResult: decodeRoundResult(publicState.roundResult),
      revealedImposterIds: objectIds(publicState.revealedImposterIds),
      revealedSecretWord: publicState.revealedSecretWord ?? null,
    }
  }

  private requestVoteSync(code: string): void {
    this.voteSyncPending.add(code)
    if (this.voteSyncing.has(code)) return
    this.voteSyncing.add(code)
    void (async () => {
      try {
        while (this.voteSyncPending.delete(code)) await this.syncVoteProgress(code)
      } catch (error) { console.error('Unable to synchronize vote progress.', error) }
      finally { this.voteSyncing.delete(code) }
    })()
  }

  private async syncVoteProgress(code: string): Promise<void> {
    const [state, players, votes] = await Promise.all([this.readPublic(code), this.readPlayers(code), this.readVotes(code)])
    if ((state.phase !== 'voting' && state.phase !== 'runoff-voting') || !state.voting || state.voting.manualResolutionRequired) return
    const candidates = objectIds(state.voting.candidateIds)
    const validVoters = players.filter((player) => candidates.some((candidate) => candidate !== player.id)).map((player) => player.id)
    const submitted = validVoters.filter((id) => votes[id]?.votingRound === state.voting!.votingRound && candidates.includes(votes[id].candidateUid) && votes[id].candidateUid !== id)
    if (submitted.length !== state.voting.submittedCount) {
      await update(ref(firebaseDatabase), {
        [roomPath(code, 'public/voting/submittedCount')]: submitted.length,
        [roomPath(code, 'public/voting/eligibleVoterCount')]: validVoters.length,
        [roomPath(code, 'public/voting/waitingPlayerIds')]: idObject(validVoters.filter((id) => !submitted.includes(id))),
        [roomPath(code, 'public/stateVersion')]: state.stateVersion + 1,
      })
    }
    if (submitted.length >= validVoters.length && submitted.length > 0) await this.finishBallot(code)
  }

  subscribeToGameState(rawCode: string, playerId: string | null, callback: GameStateListener): () => void {
    const code = normalizeCode(rawCode)
    let active = true
    let lastState = ''
    let queued = false
    const unsubscribers: Unsubscribe[] = []
    const emit = () => {
      if (!active || queued) return
      queued = true
      queueMicrotask(async () => {
        queued = false
        if (!active) return
        try {
          const state = playerId ? await this.getGameState(code, playerId) : await this.hostRoom(code)
          const serialized = JSON.stringify(state)
          if (serialized !== lastState && active) { lastState = serialized; callback(state) }
        } catch (error) {
          console.error('Realtime room update failed.', error)
        }
      })
    }
    void (async () => {
      await ensureAnonymousUser()
      if (!active) return
      const paths = playerId
        ? ['public', 'players', `assignments/${playerId}`, `votes/${playerId}`]
        : ['public', 'players', 'votes', 'hostState', 'config/rounds']
      for (const path of paths) {
        unsubscribers.push(onValue(ref(firebaseDatabase, roomPath(code, path)), () => {
          if (!playerId && path === 'votes') this.requestVoteSync(code)
          emit()
        }, (error) => console.error(`Firebase listener failed for ${path}.`, error)))
      }
    })().catch((error) => console.error('Could not start room subscription.', error))
    return () => { active = false; unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe()) }
  }
}
