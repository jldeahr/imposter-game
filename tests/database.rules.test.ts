import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { get, ref, runTransaction, set, update } from 'firebase/database'

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

  it('allows a player to join an open room without prior roster read access', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await update(ref(context.database(), `rooms/${room}/joinInfo`), { phase: 'lobby' })
      await update(ref(context.database(), `rooms/${room}/public`), { phase: 'lobby' })
    })
    const newcomer = environment.authenticatedContext('newPlayer').database()
    const player = { displayName: 'Casey', joinedAt: Date.now(), active: true }

    await assertFails(get(ref(newcomer, `rooms/${room}/players`)))
    await assertSucceeds(set(ref(newcomer, `rooms/${room}/players/newPlayer`), player))
    await assertSucceeds(get(ref(newcomer, `rooms/${room}/players`)))
    await assertSucceeds(get(ref(newcomer, `rooms/${room}/public`)))
  })

  it('rejects joining as another user or while the room is closed', async () => {
    const newcomer = environment.authenticatedContext('newPlayer').database()
    const player = { displayName: 'Casey', joinedAt: Date.now(), active: true }

    await assertFails(set(ref(newcomer, `rooms/${room}/players/someoneElse`), player))
    await assertFails(set(ref(newcomer, `rooms/${room}/players/newPlayer`), player))
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

  it('allows every database-backed host and player button through a complete game lifecycle', async () => {
    const host = environment.authenticatedContext('host').database()
    const player1 = environment.authenticatedContext('player1').database()
    const player2 = environment.authenticatedContext('player2').database()
    const path = (child: string): string => `rooms/${room}/${child}`

    await environment.withSecurityRulesDisabled(async (context) => {
      await update(ref(context.database()), {
        [path('joinInfo/phase')]: 'lobby',
        [path('public/phase')]: 'lobby',
        [path('public/currentRoundIndex')]: -1,
        [path('public/configurationSaved')]: false,
        [path('public/configurationLocked')]: false,
        [path('public/voting')]: null,
        [path('public/roundResult')]: null,
        [path('public/stateVersion')]: 1,
        [path('assignments')]: null,
        [path('votes')]: null,
        [path('hostState')]: { imposterIds: {}, roundResult: null },
      })
    })

    // Save setup.
    await assertSucceeds(update(ref(host), {
      [path('config/rounds')]: {
        0: { category: 'Places', secretWord: 'Library' },
        1: { category: 'People', secretWord: 'Teacher' },
        2: { category: 'Things', secretWord: 'Backpack' },
      },
      [path('public/configurationSaved')]: true,
      [path('public/stateVersion')]: 2,
    }))

    // Start round 1.
    await assertSucceeds(update(ref(host), {
      [path('assignments')]: {
        player1: { roundIndex: 0, category: 'Places', role: 'normal', secretWord: 'Library' },
        player2: { roundIndex: 0, category: 'Places', role: 'imposter' },
      },
      [path('votes')]: null,
      [path('hostState')]: { imposterIds: { player2: true }, roundResult: null },
      [path('public/phase')]: 'role-reveal',
      [path('public/currentRoundIndex')]: 0,
      [path('public/category')]: 'Places',
      [path('public/playerCount')]: 2,
      [path('public/imposterCount')]: 1,
      [path('public/configurationLocked')]: true,
      [path('public/voting')]: null,
      [path('public/roundResult')]: null,
      [path('public/revealedImposterIds')]: null,
      [path('public/revealedSecretWord')]: null,
      [path('public/stateVersion')]: 3,
      [path('joinInfo/phase')]: 'role-reveal',
    }))

    // Start clues, open discussion, then open voting.
    await assertSucceeds(update(ref(host), {
      [path('public/phase')]: 'clue-giving', [path('public/stateVersion')]: 4, [path('joinInfo/phase')]: 'clue-giving',
    }))
    await assertSucceeds(update(ref(host), {
      [path('public/phase')]: 'discussion', [path('public/stateVersion')]: 5, [path('joinInfo/phase')]: 'discussion',
    }))
    await assertSucceeds(update(ref(host), {
      [path('votes')]: null,
      [path('public/phase')]: 'voting',
      [path('public/voting')]: {
        submittedCount: 0, eligibleVoterCount: 2, waitingPlayerIds: { player1: true, player2: true },
        candidateIds: { player1: true, player2: true }, runoffNumber: 0,
        manualResolutionRequired: false, votingRound: '0:0',
      },
      [path('public/stateVersion')]: 6,
      [path('joinInfo/phase')]: 'voting',
    }))

    // Each player submits one private vote using the same transaction API as the app.
    await assertSucceeds(runTransaction(ref(player1, path('votes/player1')), (current) => current ?? { candidateUid: 'player2', votingRound: '0:0' }))
    await assertSucceeds(runTransaction(ref(player2, path('votes/player2')), (current) => current ?? { candidateUid: 'player1', votingRound: '0:0' }))

    // Close voting and manually resolve the tie.
    await assertSucceeds(update(ref(host), {
      [path('votes')]: null,
      [path('public/phase')]: 'runoff-voting',
      [path('public/voting')]: {
        submittedCount: 0, eligibleVoterCount: 2, waitingPlayerIds: { player1: true, player2: true },
        candidateIds: { player1: true, player2: true }, runoffNumber: 4,
        manualResolutionRequired: true, votingRound: '0:4',
      },
      [path('public/stateVersion')]: 7,
      [path('joinInfo/phase')]: 'runoff-voting',
    }))
    const initialResult = {
      selectedPlayerId: 'player2', selectedWasImposter: true, suspectRevealed: false,
      imposterGuessCorrect: null, groupPoints: 0, imposterPoints: 0,
    }
    await assertSucceeds(update(ref(host), {
      [path('votes')]: null,
      [path('hostState/roundResult')]: initialResult,
      [path('public/phase')]: 'vote-result',
      [path('public/voting')]: null,
      [path('public/roundResult')]: { ...initialResult, selectedWasImposter: false },
      [path('public/stateVersion')]: 8,
      [path('joinInfo/phase')]: 'vote-result',
    }))

    // Reveal result, reveal imposters, record the word guess, and finish the round.
    const revealedResult = { ...initialResult, suspectRevealed: true, groupPoints: 1 }
    await assertSucceeds(update(ref(host), {
      [path('hostState/roundResult')]: revealedResult,
      [path('public/roundResult')]: revealedResult,
      [path('public/scores')]: { group: 1, imposters: 0 },
      [path('public/stateVersion')]: 9,
    }))
    await assertSucceeds(update(ref(host), {
      [path('public/phase')]: 'imposter-reveal',
      [path('public/stateVersion')]: 10,
      [path('joinInfo/phase')]: 'imposter-reveal',
      [path('public/revealedImposterIds')]: { player2: true },
    }))
    await assertSucceeds(update(ref(host), {
      [path('public/phase')]: 'imposter-word-guess',
      [path('public/stateVersion')]: 11,
      [path('joinInfo/phase')]: 'imposter-word-guess',
    }))
    const finalResult = { ...revealedResult, imposterGuessCorrect: false }
    await assertSucceeds(update(ref(host), {
      [path('hostState/roundResult')]: finalResult,
      [path('public/roundResult')]: finalResult,
      [path('public/scores')]: { group: 1, imposters: 0 },
      [path('public/phase')]: 'round-result',
      [path('public/revealedSecretWord')]: 'Library',
      [path('public/stateVersion')]: 12,
      [path('joinInfo/phase')]: 'round-result',
    }))

    // Remove a player between rounds, then advance to the next round.
    await assertSucceeds(update(ref(host), {
      [path('players/player2/active')]: false,
      [path('assignments/player2')]: null,
      [path('votes/player2')]: null,
      [path('public/playerCount')]: 1,
      [path('public/stateVersion')]: 13,
    }))
    await assertSucceeds(update(ref(host), {
      [path('assignments')]: {
        player1: { roundIndex: 1, category: 'People', role: 'imposter' },
      },
      [path('votes')]: null,
      [path('hostState')]: { imposterIds: { player1: true }, roundResult: null },
      [path('public/phase')]: 'role-reveal',
      [path('public/currentRoundIndex')]: 1,
      [path('public/category')]: 'People',
      [path('public/playerCount')]: 1,
      [path('public/imposterCount')]: 1,
      [path('public/configurationLocked')]: true,
      [path('public/voting')]: null,
      [path('public/roundResult')]: null,
      [path('public/revealedImposterIds')]: null,
      [path('public/revealedSecretWord')]: null,
      [path('public/stateVersion')]: 14,
      [path('joinInfo/phase')]: 'role-reveal',
    }))

    // Put the fixture at the last round result to exercise Finish Game and Reset.
    await environment.withSecurityRulesDisabled(async (context) => {
      await update(ref(context.database()), {
        [path('public/phase')]: 'round-result',
        [path('public/currentRoundIndex')]: 2,
        [path('public/stateVersion')]: 15,
        [path('joinInfo/phase')]: 'round-result',
      })
    })
    await assertSucceeds(update(ref(host), {
      [path('votes')]: null,
      [path('assignments')]: null,
      [path('public/voting')]: null,
      [path('public/phase')]: 'complete',
      [path('public/stateVersion')]: 16,
      [path('joinInfo/phase')]: 'complete',
    }))
    await assertSucceeds(update(ref(host), {
      [path('assignments')]: null,
      [path('votes')]: null,
      [path('hostState')]: { imposterIds: {}, roundResult: null },
      [path('public/phase')]: 'lobby',
      [path('public/currentRoundIndex')]: -1,
      [path('public/category')]: '',
      [path('public/imposterCount')]: 0,
      [path('public/configurationLocked')]: false,
      [path('public/scores')]: { group: 0, imposters: 0 },
      [path('public/voting')]: null,
      [path('public/roundResult')]: null,
      [path('public/revealedImposterIds')]: null,
      [path('public/revealedSecretWord')]: null,
      [path('public/stateVersion')]: 17,
      [path('joinInfo/phase')]: 'lobby',
    }))
  })
})
