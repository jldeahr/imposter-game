import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_ROUNDS } from '../config/gameConfig'
import { LocalGameService } from './LocalGameService'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const storage = new MemoryStorage()
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
if (!globalThis.CustomEvent) {
  Object.defineProperty(globalThis, 'CustomEvent', { value: class<T> extends Event { detail: T; constructor(type: string, init?: CustomEventInit<T>) { super(type); this.detail = init?.detail as T } } })
}

async function roomWithPlayers(count = 4) {
  const service = new LocalGameService()
  let room = await service.createRoom()
  room = await service.updateRoundConfiguration(room.code, [...DEFAULT_ROUNDS])
  for (let index = 0; index < count; index += 1) room = await service.joinRoom(room.code, `Player ${index + 1}`)
  return { service, room }
}

async function reachVoting(service: LocalGameService, code: string) {
  await service.startRound(code)
  await service.startClueGiving(code)
  await service.openDiscussion(code)
  return service.openVoting(code)
}

beforeEach(() => storage.clear())

describe('host round configuration', () => {
  it('loads the three defaults and persists trimmed edits including multi-word words', async () => {
    const service = new LocalGameService()
    const room = await service.createRoom()
    expect(await service.getRoundConfiguration(room.code)).toEqual(DEFAULT_ROUNDS)
    const configured = await service.updateRoundConfiguration(room.code, [
      { category: ' Places ', secretWord: ' New York City ' },
      { category: ' Films ', secretWord: ' The Empire Strikes Back ' },
      { category: ' People ', secretWord: ' Grace Hopper ' },
    ])
    expect(configured.rounds[0]).toEqual({ category: 'Places', secretWord: 'New York City' })
    expect((await service.getRoom(room.code))?.rounds[1].secretWord).toBe('The Empire Strikes Back')
    expect(configured.configurationSaved).toBe(true)
  })

  it.each([
    [[{ category: ' ', secretWord: 'Word' }, ...DEFAULT_ROUNDS.slice(1)], /category/],
    [[{ category: 'Category', secretWord: '\t' }, ...DEFAULT_ROUNDS.slice(1)], /secret word/],
  ])('rejects blank and whitespace-only values', async (rounds, message) => {
    const service = new LocalGameService()
    const room = await service.createRoom()
    await expect(service.updateRoundConfiguration(room.code, rounds)).rejects.toThrow(message)
  })

  it('requires a saved setup and locks configuration once round one starts', async () => {
    const service = new LocalGameService()
    let room = await service.createRoom()
    room = await service.joinRoom(room.code, 'Player')
    await expect(service.startRound(room.code)).rejects.toThrow(/Save/)
    await service.updateRoundConfiguration(room.code, [...DEFAULT_ROUNDS])
    await service.startRound(room.code)
    await expect(service.updateRoundConfiguration(room.code, [...DEFAULT_ROUNDS])).rejects.toThrow(/not available|locked/)
  })

  it('sends only the configured current-round assignment and never gives an imposter the word', async () => {
    const { service, room } = await roomWithPlayers(4)
    const custom = [
      { category: 'Cities', secretWord: 'New York City' },
      { category: 'Science', secretWord: 'Event Horizon' },
      { category: 'Music', secretWord: 'French Horn' },
    ]
    await service.updateRoundConfiguration(room.code, custom)
    await service.startRound(room.code)
    const states = await Promise.all(room.players.map((player) => service.getGameState(room.code, player.id)))
    const normal = states.find((state) => !state.assignment?.isImposter)!
    const imposter = states.find((state) => state.assignment?.isImposter)!
    expect(normal.assignment).toMatchObject({ category: 'Cities', secretWord: 'New York City' })
    expect(imposter.assignment).toMatchObject({ category: 'Cities', secretWord: null })
    expect(normal).not.toHaveProperty('rounds')
    expect(JSON.stringify(imposter)).not.toContain('New York City')
    expect(JSON.stringify(normal)).not.toContain('Bible')
  })

  it('auto-syncs configured values and loads the next configured round', async () => {
    const { service, room } = await roomWithPlayers(4)
    await service.updateRoundConfiguration(room.code, [
      { category: 'First Custom', secretWord: 'First Phrase' },
      { category: 'Second Custom', secretWord: 'Second Phrase' },
      { category: 'Third Custom', secretWord: 'Third Phrase' },
    ])
    const playerId = room.players[0].id
    const categories: string[] = []
    const unsubscribe = service.subscribeToGameState(room.code, playerId, (state) => {
      if ('player' in state && state.assignment) categories.push(state.assignment.category)
    })
    await Promise.resolve()
    await service.startRound(room.code)
    await service.startClueGiving(room.code)
    await service.openDiscussion(room.code)
    const voting = await service.openVoting(room.code)
    await service.submitVote(room.code, voting.players[0].id, voting.players[1].id)
    await service.closeVoting(room.code)
    await service.revealVoteResult(room.code)
    await service.revealImposters(room.code)
    await service.beginImposterGuess(room.code)
    await service.recordImposterGuess(room.code, false)
    await service.advanceRound(room.code)
    const next = await service.getGameState(room.code, playerId)
    const assignment = next.assignment
    expect(assignment?.category).toBe('Second Custom')
    if (assignment && !assignment.isImposter) expect(assignment.secretWord).toBe('Second Phrase')
    expect(categories).toContain('First Custom')
    expect(categories).toContain('Second Custom')
    unsubscribe()
  })
})

describe('local game voting and validation', () => {
  it('keeps ballots private and rejects self and duplicate votes', async () => {
    const { service, room } = await roomWithPlayers()
    const voting = await reachVoting(service, room.code)
    const [a, b, c] = voting.players
    await expect(service.submitVote(room.code, a.id, a.id)).rejects.toThrow(/yourself/)
    await service.submitVote(room.code, a.id, b.id)
    await expect(service.submitVote(room.code, a.id, c.id)).rejects.toThrow(/already/)
    expect(await service.getRoom(room.code)).not.toHaveProperty('ballots')
    expect((await service.getGameState(room.code, b.id)).voting).not.toHaveProperty('totals')
  })

  it('automatically resolves a clear winner and scores only once', async () => {
    const { service, room } = await roomWithPlayers()
    const voting = await reachVoting(service, room.code)
    const [a, b, c, d] = voting.players
    await service.submitVote(room.code, a.id, b.id)
    await service.submitVote(room.code, b.id, a.id)
    await service.submitVote(room.code, c.id, b.id)
    const resolved = await service.submitVote(room.code, d.id, b.id)
    expect(resolved.phase).toBe('vote-result')
    const scored = await service.revealVoteResult(room.code)
    expect(scored.scores.group + scored.scores.imposters).toBe(1)
    await expect(service.revealVoteResult(room.code)).rejects.toThrow()
  })

  it('supports early close with partial voting', async () => {
    const { service, room } = await roomWithPlayers()
    const voting = await reachVoting(service, room.code)
    await service.submitVote(room.code, voting.players[0].id, voting.players[1].id)
    const closed = await service.closeVoting(room.code)
    expect(closed.phase).toBe('vote-result')
  })

  it('limits runoff candidates, resets submissions, and requires manual resolution after three runoff ties', async () => {
    const { service, room } = await roomWithPlayers()
    let state = await reachVoting(service, room.code)
    const [a, b, c, d] = state.players
    const tie = async () => {
      await service.submitVote(room.code, a.id, b.id)
      await service.submitVote(room.code, b.id, a.id)
      await service.submitVote(room.code, c.id, b.id)
      await service.submitVote(room.code, d.id, a.id)
    }
    await tie()
    state = (await service.getRoom(room.code))!
    expect(state.phase).toBe('runoff-voting')
    expect(state.voting?.candidateIds).toEqual([a.id, b.id])
    expect(state.voting?.submittedCount).toBe(0)
    await expect(service.submitVote(room.code, c.id, d.id)).rejects.toThrow(/not eligible/)
    await tie(); await tie(); await tie()
    state = (await service.getRoom(room.code))!
    expect(state.voting?.manualResolutionRequired).toBe(true)
    const resolved = await service.resolveVote(room.code, a.id)
    expect(resolved.phase).toBe('vote-result')
  })
})

describe('round state and synchronization', () => {
  it('publishes monotonic automatic updates and restores current state', async () => {
    const { service, room } = await roomWithPlayers(3)
    const playerId = room.players[0].id
    const phases: string[] = []
    const versions: number[] = []
    const unsubscribe = service.subscribeToGameState(room.code, playerId, (state) => { phases.push(state.phase); versions.push(state.version) })
    await Promise.resolve()
    await service.startRound(room.code)
    await service.startClueGiving(room.code)
    await service.openDiscussion(room.code)
    await service.openVoting(room.code)
    expect(phases).toEqual(['lobby', 'role-reveal', 'clue-giving', 'discussion', 'voting'])
    expect(versions.every((version, index) => index === 0 || version > versions[index - 1])).toBe(true)
    const beforeStaleEvent = phases.length
    window.dispatchEvent(new CustomEvent('imposter-game:changed', { detail: { version: 1 } }))
    expect(phases).toHaveLength(beforeStaleEvent)
    expect((await service.getGameState(room.code, playerId)).phase).toBe('voting')
    unsubscribe()
  })

  it('recalculates imposter count between rounds but not during a round and clears voting state', async () => {
    const { service, room } = await roomWithPlayers(11)
    let state = await reachVoting(service, room.code)
    expect(state.imposterCount).toBe(1)
    const [a, b] = state.players
    await service.submitVote(room.code, a.id, b.id)
    await service.closeVoting(room.code)
    await service.revealVoteResult(room.code)
    await service.revealImposters(room.code)
    await service.beginImposterGuess(room.code)
    await service.recordImposterGuess(room.code, false)
    state = await service.joinRoom(room.code, 'Player 12')
    expect(state.imposterCount).toBe(1)
    state = await service.advanceRound(room.code)
    expect(state.imposterCount).toBe(2)
    expect(state.voting).toBeNull()
    expect(state.roundResult).toBeNull()
  })

  it('completes all three rounds and replaces each round assignment', async () => {
    const { service, room } = await roomWithPlayers(4)
    const playerId = room.players[0].id
    let previousVersion = 0
    for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
      if (roundIndex === 0) await service.startRound(room.code)
      const role = await service.getGameState(room.code, playerId)
      expect(role.currentRoundIndex).toBe(roundIndex)
      expect(role.assignment?.roundNumber).toBe(roundIndex + 1)
      expect(role.version).toBeGreaterThan(previousVersion)
      previousVersion = role.version
      await service.startClueGiving(room.code)
      await service.openDiscussion(room.code)
      const voting = await service.openVoting(room.code)
      await service.submitVote(room.code, voting.players[0].id, voting.players[1].id)
      await service.closeVoting(room.code)
      await service.revealVoteResult(room.code)
      await service.revealImposters(room.code)
      await service.beginImposterGuess(room.code)
      const result = await service.recordImposterGuess(room.code, roundIndex === 0)
      expect(result.voting).toBeNull()
      if (roundIndex < 2) await service.advanceRound(room.code)
    }
    const complete = await service.finishGame(room.code)
    expect(complete.phase).toBe('complete')
    expect(complete.currentRoundIndex).toBe(2)
  })
})
