import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { get, ref, set, update } from 'firebase/database'

let environment: RulesTestEnvironment
const room = 'ABC234'

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'imposter-game-6c060',
    database: { rules: readFileSync('database.rules.json', 'utf8') },
  })
})

beforeEach(async () => {
  await environment.clearDatabase()
  await environment.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), `rooms/${room}`), {
      meta: { hostUid: 'host', createdAt: 1 },
      joinInfo: { phase: 'voting', createdAt: 1 },
      public: {
        phase: 'voting', currentRoundIndex: 0, category: 'Custom', playerCount: 2, imposterCount: 1,
        configurationSaved: true, configurationLocked: true, scores: { group: 0, imposters: 0 }, stateVersion: 4,
        voting: { submittedCount: 0, eligibleVoterCount: 2, waitingPlayerIds: { player1: true, player2: true }, candidateIds: { player1: true, player2: true }, runoffNumber: 0, manualResolutionRequired: false, votingRound: '0:0' },
      },
      players: {
        player1: { displayName: 'Alex', joinedAt: 2, active: true },
        player2: { displayName: 'Blair', joinedAt: 3, active: true },
      },
      assignments: {
        player1: { roundIndex: 0, category: 'Custom', role: 'normal', secretWord: 'Hidden Phrase' },
        player2: { roundIndex: 0, category: 'Custom', role: 'imposter' },
      },
      config: { rounds: { 0: { category: 'Custom', secretWord: 'Hidden Phrase' } } },
      hostState: { imposterIds: { player2: true } },
    })
    await set(ref(context.database(), 'rooms/OTHER99'), {
      meta: { hostUid: 'otherHost', createdAt: 1 },
      public: { phase: 'lobby', currentRoundIndex: -1, scores: { group: 0, imposters: 0 }, stateVersion: 1 },
      players: { outsider: { displayName: 'Outsider', joinedAt: 1, active: true } },
    })
  })
})

afterAll(async () => environment.cleanup())

describe('Realtime Database security boundaries', () => {
  it('allows an authenticated host to create a complete room', async () => {
    const host = environment.authenticatedContext('newHost').database()
    const code = 'NEW234'
    const createdAt = Date.now()

    await assertSucceeds(set(ref(host, `rooms/${code}/meta`), { hostUid: 'newHost', createdAt }))
    await assertSucceeds(update(ref(host), {
      [`rooms/${code}/joinInfo`]: { phase: 'lobby', createdAt },
      [`rooms/${code}/public`]: {
        phase: 'lobby', currentRoundIndex: -1, category: '', playerCount: 0, imposterCount: 0,
        configurationSaved: false, configurationLocked: false, scores: { group: 0, imposters: 0 }, stateVersion: 1,
      },
      [`rooms/${code}/config/rounds`]: {
        0: { category: 'Places', secretWord: 'Library' },
        1: { category: 'People', secretWord: 'Teacher' },
        2: { category: 'Things', secretWord: 'Backpack' },
      },
      [`rooms/${code}/hostState`]: { imposterIds: {}, roundResult: null },
    }))
    await assertSucceeds(get(ref(host, `rooms/${code}/public`)))
  })

  it('denies unauthenticated protected reads and unrelated-room access', async () => {
    await assertFails(get(ref(environment.unauthenticatedContext().database(), `rooms/${room}/public`)))
    await assertFails(get(ref(environment.authenticatedContext('player1').database(), 'rooms/OTHER99/public')))
  })

  it('allows members to read public state and their own assignment only', async () => {
    const player = environment.authenticatedContext('player1').database()
    await assertSucceeds(get(ref(player, `rooms/${room}/public`)))
    await assertSucceeds(get(ref(player, `rooms/${room}/assignments/player1`)))
    await assertFails(get(ref(player, `rooms/${room}/assignments/player2`)))
  })

  it('prevents an imposter from discovering the word through another assignment or config', async () => {
    const imposter = environment.authenticatedContext('player2').database()
    await assertSucceeds(get(ref(imposter, `rooms/${room}/assignments/player2`)))
    await assertFails(get(ref(imposter, `rooms/${room}/assignments/player1`)))
    await assertFails(get(ref(imposter, `rooms/${room}/config`)))
  })

  it('allows exactly one valid own ballot and rejects self, other-player, and modified ballots', async () => {
    const player = environment.authenticatedContext('player1').database()
    await assertFails(set(ref(player, `rooms/${room}/votes/player1`), { candidateUid: 'player1', votingRound: '0:0' }))
    await assertFails(set(ref(player, `rooms/${room}/votes/player2`), { candidateUid: 'player1', votingRound: '0:0' }))
    await assertSucceeds(set(ref(player, `rooms/${room}/votes/player1`), { candidateUid: 'player2', votingRound: '0:0' }))
    await assertFails(set(ref(player, `rooms/${room}/votes/player1`), { candidateUid: 'player2', votingRound: '0:1' }))
  })

  it('prevents ordinary players from changing phases, scores, assignments, or other player records', async () => {
    const player = environment.authenticatedContext('player1').database()
    await assertFails(set(ref(player, `rooms/${room}/public/phase`), 'complete'))
    await assertFails(set(ref(player, `rooms/${room}/public/scores/group`), 99))
    await assertFails(set(ref(player, `rooms/${room}/assignments/player2`), { roundIndex: 0, category: 'X', role: 'normal', secretWord: 'Leaked' }))
    await assertFails(set(ref(player, `rooms/${room}/players/player2/active`), false))
  })

  it('allows the host to perform host-controlled writes and read ballots', async () => {
    const host = environment.authenticatedContext('host').database()
    await assertSucceeds(update(ref(host, `rooms/${room}/public`), { phase: 'discussion', stateVersion: 5 }))
    await assertSucceeds(set(ref(host, `rooms/${room}/assignments/player2`), { roundIndex: 0, category: 'Custom', role: 'imposter' }))
    await assertSucceeds(get(ref(host, `rooms/${room}/votes`)))
  })
})
