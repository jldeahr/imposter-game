import QRCode from 'qrcode'
import './style.css'
import { GAME_CONFIG } from './config/gameConfig'
import { getImposterCount } from './domain/gameLogic'
import { createTimer, resetTimer, startTimer, tickTimer, type TimerState } from './domain/timer'
import type { GameRoom, Player, PlayerGameState } from './domain/types'
import { RULES } from './rules'
import { buildJoinUrl } from './routing'
import { FirebaseGameService } from './services/FirebaseGameService'

const app = document.querySelector<HTMLDivElement>('#app')!
const service = new FirebaseGameService()
let unsubscribe: (() => void) | null = null
let timer: TimerState = createTimer(GAME_CONFIG.discussionSeconds)
let timerInterval: number | undefined
const editingSetups = new Set<string>()

const escapeHtml = (value: string): string => { const element = document.createElement('div'); element.textContent = value; return element.innerHTML }
const route = (): string[] => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
const navigate = (path: string): void => { location.hash = path }
const nameFor = (players: Player[], id: string): string => players.find((player) => player.id === id)?.name ?? 'Unknown player'

function shell(content: string, compact = false): string {
  return `<div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
    <header class="topbar ${compact ? 'topbar-compact' : ''}"><a class="brand" href="#/"><span class="brand-mark">I?</span><span>Imposter Game</span></a><a class="text-link" href="#/rules">Rules</a></header>
    <main>${content}</main><footer>Three rounds. One word. Trust no clue.</footer>`
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Something went wrong.'
function showToast(message: string, kind: 'error' | 'success' = 'error'): void {
  const toast = document.createElement('div'); toast.className = `toast ${kind}`; toast.textContent = message; document.body.append(toast); setTimeout(() => toast.remove(), 3200)
}

function stopTimer(): void { if (timerInterval !== undefined) window.clearInterval(timerInterval); timerInterval = undefined }
const formatTimer = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

function renderHome(): void {
  app.innerHTML = shell(`<section class="hero"><p class="eyebrow">A three-round party game</p><h1>Know the word.<br><span>Hide the truth.</span></h1><p class="hero-copy">Give a clever clue, spot the bluff, and privately vote from your phone.</p><div class="action-stack"><button class="button primary" id="create-game">Host a game <span>→</span></button><button class="button secondary" id="join-game">Join with a code</button></div><p class="demo-note"><span class="dot"></span> Live multiplayer powered by anonymous Firebase sessions</p></section>
    <section class="how-it-works"><p class="eyebrow">How it works</p><div class="steps"><article><strong>01</strong><h2>Get your role</h2><p>Most players see the word. Imposters see only the category.</p></article><article><strong>02</strong><h2>Give one clue</h2><p>Use two words or fewer, then discuss for two minutes.</p></article><article><strong>03</strong><h2>Vote privately</h2><p>Choose a suspect in the app; ties automatically go to a runoff.</p></article></div></section>`)
  document.querySelector('#create-game')?.addEventListener('click', async () => navigate(`/host/${(await service.createRoom()).code}`))
  document.querySelector('#join-game')?.addEventListener('click', () => navigate('/join'))
}

function renderJoin(code = ''): void {
  app.innerHTML = shell(`<section class="narrow card-page"><a href="#/" class="back-link">← Back home</a><div class="panel join-panel"><p class="eyebrow">Join the game</p><h1>Your seat is waiting.</h1><p class="muted">Enter a nickname to join from this device.</p><form id="join-form"><label for="room-code">Room code</label><input id="room-code" name="code" value="${escapeHtml(code)}" maxlength="6" required placeholder="ABC234"><label for="nickname">Nickname</label><input id="nickname" name="name" maxlength="24" required placeholder="What should we call you?"><button class="button primary" type="submit">Join room <span>→</span></button></form></div></section>`)
  document.querySelector<HTMLFormElement>('#join-form')!.addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement)
    try { const room = await service.joinRoom(String(data.get('code')), String(data.get('name'))); const playerId = await service.getCurrentPlayerId(); navigate(`/play/${room.code}/${playerId}`) }
    catch (error) { console.error(error); showToast(errorMessage(error)) }
  })
}

function playerList(players: Player[], removable: boolean): string {
  if (!players.length) return '<div class="empty-state">No players yet. Share the code or QR to invite them.</div>'
  return `<ul class="player-list">${players.map((player, index) => `<li><span class="player-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(player.name)}</span>${removable ? `<button class="icon-button remove-player" data-player="${player.id}" aria-label="Remove ${escapeHtml(player.name)}">×</button>` : ''}</li>`).join('')}</ul>`
}

function timerMarkup(): string {
  return `<div class="timer-card ${timer.remaining === 0 ? 'timer-done' : ''}"><p class="eyebrow">Discussion timer</p><div class="timer-value" id="timer-value">${formatTimer(timer.remaining)}</div>${timer.remaining === 0 ? '<p class="result-copy">Discussion is over. Open voting when ready.</p>' : ''}<div class="button-row"><button class="button primary" id="timer-toggle">${timer.running ? 'Pause' : timer.remaining === 0 ? 'Time’s up' : 'Start timer'}</button><button class="button secondary" id="timer-reset">Reset</button></div></div>`
}

function lobbyMarkup(room: GameRoom, joinUrl: string): string {
  const count = room.players.length
  const editing = !room.configurationSaved || editingSetups.has(room.code)
  const setup = editing
    ? `<section class="panel setup-panel"><div class="section-heading"><div><p class="eyebrow">Game setup</p><h2>Configure all three rounds</h2></div></div><p class="muted">Secret words are visible here only while the host is setting up the game.</p><form id="setup-form"><div class="round-setup-grid">${room.rounds.map((round, index) => `<fieldset><legend>Round ${index + 1}</legend><label for="category-${index}">Category</label><input id="category-${index}" name="category-${index}" value="${escapeHtml(round.category)}" required aria-describedby="category-error-${index}"><span class="field-error" id="category-error-${index}"></span><label for="word-${index}">Secret word</label><input id="word-${index}" name="word-${index}" value="${escapeHtml(round.secretWord)}" required aria-describedby="word-error-${index}"><span class="field-error" id="word-error-${index}"></span></fieldset>`).join('')}</div><button class="button primary" type="submit">Save setup</button></form></section>`
    : `<section class="panel setup-panel"><div class="section-heading"><div><p class="eyebrow">Game setup saved</p><h2>Three rounds ready</h2></div><button class="button secondary" id="edit-setup">Edit setup</button></div><ol class="setup-summary">${room.rounds.map((round, index) => `<li><strong>Round ${index + 1}</strong><span>${escapeHtml(round.category)}</span></li>`).join('')}</ol><p class="fine-print">Secret words are hidden from the shared summary.</p></section>`
  return `${setup}<div class="dashboard-grid"><section class="panel players-panel"><div class="section-heading"><div><p class="eyebrow">Players</p><h2>${count} player${count === 1 ? '' : 's'} joined</h2></div>${count ? `<span class="pill">${getImposterCount(count)} imposter${getImposterCount(count) === 1 ? '' : 's'}</span>` : ''}</div>${playerList(room.players, true)}<button class="button primary full" id="start-round" ${count && room.configurationSaved && !editing ? '' : 'disabled'}>Start Round 1 <span>→</span></button>${!room.configurationSaved ? '<p class="fine-print">Save the game setup before starting.</p>' : ''}</section><aside class="panel invite-panel"><p class="eyebrow">Join with this code</p><div id="qr-code" class="qr-code"></div><p class="join-url">${escapeHtml(joinUrl)}</p><button class="button secondary full" id="copy-link">Copy link</button><p class="fine-print">Players can scan this QR code from their own phones.</p></aside></div>`
}

function scoreMarkup(room: GameRoom): string {
  return `<div class="panel score-card"><p class="eyebrow">Total score</p><div class="score-line"><span>Group</span><strong>${room.scores.group}</strong></div><div class="score-line"><span>Imposters</span><strong>${room.scores.imposters}</strong></div></div>`
}

function hostRoundMarkup(room: GameRoom): string {
  const round = room.rounds[room.currentRoundIndex]
  const roundNumber = room.currentRoundIndex + 1
  const phase = room.phase
  let primary = ''
  if (phase === 'role-reveal') primary = `<p class="eyebrow">Role reveal</p><h2>Everyone checks their private role.</h2><div class="role-links">${room.players.map((p) => `<a class="player-role-link" href="#/play/${room.code}/${p.id}"><span>${escapeHtml(p.name)}</span><span>Open player view →</span></a>`).join('')}</div><button class="button primary full phase-action" data-action="clues">Start clue giving</button>`
  if (phase === 'clue-giving') primary = `<p class="eyebrow">Clue giving</p><h2>One clue each. Two words maximum.</h2><p class="muted">When everyone has given a clue, open the discussion.</p><button class="button primary full phase-action" data-action="discussion">Open discussion</button>`
  if (phase === 'discussion') primary = `<p class="eyebrow">Discussion</p><h2>Find the bluff.</h2><p class="muted">Voting can be opened early, or after the timer reaches zero.</p><button class="button primary full phase-action" data-action="voting">Open voting</button>`
  if (phase === 'voting' || phase === 'runoff-voting') {
    const voting = room.voting!
    const waiting = voting.waitingPlayerIds.map((id) => escapeHtml(nameFor(room.players, id))).join(', ')
    const manual = voting.manualResolutionRequired
    primary = `<p class="eyebrow">${phase === 'runoff-voting' ? 'Runoff vote' : 'Voting'}</p><h2>${voting.submittedCount} of ${voting.eligibleVoterCount} votes submitted</h2>${phase === 'runoff-voting' ? `<p class="muted">${voting.candidateIds.length} players tied. Runoff ${voting.runoffNumber}.</p>` : ''}${waiting && !manual ? `<p class="fine-print">Waiting for: ${waiting}</p>` : ''}${manual ? `<div class="reveal-result"><h3>Manual tie resolution</h3><p>Three runoff votes tied. Choose the suspect after the room decides.</p><div class="candidate-grid">${voting.candidateIds.map((id) => `<button class="vote-option manual-choice" data-candidate="${id}">${escapeHtml(nameFor(room.players, id))}</button>`).join('')}</div></div>` : '<button class="button danger full phase-action" data-action="close-voting">Close voting early</button>'}`
  }
  if (phase === 'vote-result') {
    const result = room.roundResult!
    const selected = escapeHtml(nameFor(room.players, result.selectedPlayerId))
    primary = `<p class="eyebrow">The group chose</p><h2 class="big-result">${selected}</h2>${result.suspectRevealed ? `<div class="reveal-result"><p class="eyebrow">${result.selectedWasImposter ? 'Correct' : 'Incorrect'}</p><h2>${selected} was ${result.selectedWasImposter ? 'an imposter' : 'not an imposter'}.</h2></div><button class="button primary full phase-action" data-action="reveal-imposters">Reveal imposters</button>` : '<button class="button danger full phase-action" data-action="reveal-result">Reveal whether they were an imposter</button>'}`
  }
  if (phase === 'imposter-reveal') primary = `<p class="eyebrow">Imposters revealed</p><h2>${room.imposterIds.map((id) => escapeHtml(nameFor(room.players, id))).join(', ')}</h2><p class="muted">Let them confer on one collective secret-word guess.</p><button class="button primary full phase-action" data-action="guess">Record word guess</button>`
  if (phase === 'imposter-word-guess') primary = `<p class="eyebrow">Collective word guess</p><h2>Was the imposters’ one guess correct?</h2><div class="button-row"><button class="button primary phase-action" data-action="guess-correct">Correct guess</button><button class="button secondary phase-action" data-action="guess-incorrect">Incorrect guess</button></div>`
  if (phase === 'round-result') {
    const result = room.roundResult!
    const selected = escapeHtml(nameFor(room.players, result.selectedPlayerId))
    primary = `<p class="eyebrow">Round ${roundNumber} complete</p><h2>Round summary</h2><dl class="summary"><dt>Group selected</dt><dd>${selected}</dd><dt>${selected} was</dt><dd>${result.selectedWasImposter ? 'IMPOSTER' : 'NORMAL'}</dd><dt>Secret word</dt><dd>${escapeHtml(round.secretWord)}</dd><dt>Imposters</dt><dd>${room.imposterIds.map((id) => escapeHtml(nameFor(room.players, id))).join(', ')}</dd><dt>Imposters guessed</dt><dd>${result.imposterGuessCorrect ? 'Correct' : 'Incorrect'}</dd><dt>Round score</dt><dd>Group +${result.groupPoints} · Imposters +${result.imposterPoints}</dd></dl><div class="between-rounds"><p class="muted">Players may join from the room link or be removed before the next round.</p>${playerList(room.players, true)}</div><button class="button primary full phase-action" data-action="advance">${room.currentRoundIndex === room.rounds.length - 1 ? 'Finish game' : `Start Round ${roundNumber + 1}`}</button>`
  }
  return `<div class="dashboard-grid"><section class="panel round-panel"><div class="round-strip"><span>Round ${roundNumber} of ${room.rounds.length}</span><span>${room.players.length} players · ${room.imposterCount} imposters</span></div>${primary}</section><aside class="host-controls">${phase === 'discussion' ? timerMarkup() : ''}${scoreMarkup(room)}</aside></div>`
}

function completeMarkup(room: GameRoom): string {
  const comparison = room.scores.group === room.scores.imposters ? 'The scores are tied.' : room.scores.group > room.scores.imposters ? 'The group wins.' : 'The imposters win.'
  return `<section class="panel finale"><p class="eyebrow">Final score</p><h2>That’s all three rounds.</h2><div class="final-scores"><div><span>Group</span><strong>${room.scores.group}</strong></div><div><span>Imposters</span><strong>${room.scores.imposters}</strong></div></div><p class="result-copy">${comparison}</p><button class="button primary" id="reset-game">Reset with same players</button></section>`
}

function renderHostState(room: GameRoom): void {
  const round = room.rounds[room.currentRoundIndex]
  const joinUrl = buildJoinUrl(location.origin, import.meta.env.BASE_URL, room.code)
  app.innerHTML = shell(`<section class="host-layout"><div class="host-header"><div><p class="eyebrow">Host dashboard · live multiplayer</p><h1>${room.phase === 'lobby' ? 'Gather your players.' : room.phase === 'complete' ? 'Game complete.' : `Round ${room.currentRoundIndex + 1} · ${escapeHtml(round.category)}`}</h1></div><div class="room-code"><span>Room code</span><strong>${room.code}</strong></div></div>${room.phase === 'lobby' ? lobbyMarkup(room, joinUrl) : room.phase === 'complete' ? completeMarkup(room) : hostRoundMarkup(room)}</section>`, true)
  bindHostEvents(room, joinUrl)
}

function bindTimerEvents(): void {
  document.querySelector('#timer-toggle')?.addEventListener('click', () => {
    if (timer.running) { timer = { ...timer, running: false }; stopTimer(); return renderCurrentRoute() }
    timer = startTimer(timer); if (!timer.running) return
    timerInterval = window.setInterval(() => { timer = tickTimer(timer); const display = document.querySelector('#timer-value'); if (display) display.textContent = formatTimer(timer.remaining); if (!timer.running) { stopTimer(); renderCurrentRoute() } }, 1000)
    renderCurrentRoute()
  })
  document.querySelector('#timer-reset')?.addEventListener('click', () => { stopTimer(); timer = resetTimer(GAME_CONFIG.discussionSeconds); renderCurrentRoute() })
}

function bindHostEvents(room: GameRoom, joinUrl: string): void {
  if (room.phase === 'lobby') {
    const canvas = document.createElement('canvas'); QRCode.toCanvas(canvas, joinUrl, { width: 196, margin: 1 }).then(() => document.querySelector('#qr-code')?.append(canvas)).catch(() => showToast('Could not draw the QR preview.'))
    document.querySelector('#copy-link')?.addEventListener('click', async () => { await navigator.clipboard.writeText(joinUrl); showToast('Join link copied.', 'success') })
    document.querySelector('#start-round')?.addEventListener('click', () => void run(() => service.startRound(room.code)))
    document.querySelector('#edit-setup')?.addEventListener('click', () => { editingSetups.add(room.code); renderHostState(room) })
    document.querySelector<HTMLFormElement>('#setup-form')?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const rounds = room.rounds.map((_, index) => ({ category: String(data.get(`category-${index}`) ?? ''), secretWord: String(data.get(`word-${index}`) ?? '') }))
      form.querySelectorAll('.field-error').forEach((element) => { element.textContent = '' })
      let invalid = false
      rounds.forEach((round, index) => {
        if (!round.category.trim()) { const error = form.querySelector(`#category-error-${index}`); if (error) error.textContent = 'Category is required.'; invalid = true }
        if (!round.secretWord.trim()) { const error = form.querySelector(`#word-error-${index}`); if (error) error.textContent = 'Secret word is required.'; invalid = true }
      })
      if (invalid) return
      editingSetups.delete(room.code)
      try { await service.updateRoundConfiguration(room.code, rounds); showToast('Game setup saved.', 'success') }
      catch (error) { editingSetups.add(room.code); showToast(errorMessage(error)) }
    })
  }
  if (room.phase === 'discussion') bindTimerEvents()
  document.querySelectorAll<HTMLButtonElement>('.remove-player').forEach((button) => button.addEventListener('click', () => void run(() => service.removePlayer(room.code, button.dataset.player!))))
  const actions: Record<string, () => Promise<unknown>> = {
    clues: () => service.startClueGiving(room.code), discussion: () => service.openDiscussion(room.code), voting: () => service.openVoting(room.code),
    'close-voting': () => service.closeVoting(room.code), 'reveal-result': () => service.revealVoteResult(room.code), 'reveal-imposters': () => service.revealImposters(room.code),
    guess: () => service.beginImposterGuess(room.code), 'guess-correct': () => service.recordImposterGuess(room.code, true), 'guess-incorrect': () => service.recordImposterGuess(room.code, false),
    advance: () => room.currentRoundIndex === room.rounds.length - 1 ? service.finishGame(room.code) : service.advanceRound(room.code),
  }
  document.querySelectorAll<HTMLButtonElement>('.phase-action').forEach((button) => button.addEventListener('click', () => void run(actions[button.dataset.action!])))
  document.querySelectorAll<HTMLButtonElement>('.manual-choice').forEach((button) => button.addEventListener('click', () => void run(() => service.resolveVote(room.code, button.dataset.candidate!))))
  document.querySelector('#reset-game')?.addEventListener('click', () => void run(() => service.resetGame(room.code)))
}

async function run(action: (() => Promise<unknown>) | undefined): Promise<void> { if (!action) return; try { await action() } catch (error) { console.error(error); showToast(errorMessage(error)) } }

function roleCard(state: PlayerGameState): string {
  const assignment = state.assignment!
  return `<div class="role-intro"><p class="eyebrow">Round ${assignment.roundNumber} · ${escapeHtml(state.player.name)}</p><h1>Your role is private.</h1><p>Make sure only you can see the screen, then press and hold.</p></div><button class="reveal-card" id="reveal-card"><div class="role-covered"><span class="fingerprint">◎</span><strong>Hold to reveal</strong><small>Release to hide</small></div><div class="role-revealed"><span class="role-label">Category</span><strong class="category">${escapeHtml(assignment.category)}</strong>${assignment.isImposter ? '<div class="divider"></div><span class="role-label warning">You are an imposter</span><p>You do not know the secret word.</p>' : `<div class="divider"></div><span class="role-label">Your word</span><strong class="secret">${escapeHtml(assignment.secretWord!)}</strong>`}</div></button><p class="round-status">${state.phase === 'role-reveal' ? 'Waiting for clue giving to begin.' : state.phase === 'clue-giving' ? 'Give one clue of no more than two words.' : 'Discussion is underway.'}</p>`
}

function playerPhaseMarkup(state: PlayerGameState): string {
  if (state.phase === 'lobby') return `<div class="waiting-orb"><span></span></div><p class="eyebrow">You’re in, ${escapeHtml(state.player.name)}</p><h1>Waiting for the host…</h1><p class="muted">Keep this page open. It updates automatically.</p>`
  if (state.phase === 'complete') return `<p class="eyebrow">Game complete</p><h1>Thanks for playing, ${escapeHtml(state.player.name)}.</h1><div class="final-scores compact"><div><span>Group</span><strong>${state.scores.group}</strong></div><div><span>Imposters</span><strong>${state.scores.imposters}</strong></div></div>`
  if (['role-reveal', 'clue-giving', 'discussion'].includes(state.phase)) return roleCard(state)
  if (state.phase === 'voting' || state.phase === 'runoff-voting') {
    const voting = state.voting!
    if (voting.manualResolutionRequired) return '<p class="eyebrow">Runoff tied</p><h1>The host will resolve the tie.</h1><p class="muted">The room can choose any fair tie-break method.</p>'
    if (voting.hasSubmitted) return '<p class="eyebrow">Vote submitted</p><h1>Waiting for the rest of the group…</h1><p class="muted">Your choice is private.</p>'
    const candidates = voting.candidateIds.filter((id) => id !== state.player.id)
    if (!candidates.length) return '<p class="eyebrow">Voting</p><h1>No eligible choice.</h1><p class="muted">Wait for the host to continue.</p>'
    return `<p class="eyebrow">${state.phase === 'runoff-voting' ? `Runoff vote ${voting.runoffNumber}` : 'Who is an imposter?'}</p><h1>Choose one person.</h1><form id="vote-form"><div class="candidate-grid">${candidates.map((id) => `<label class="vote-option"><input type="radio" name="candidate" value="${id}" required><span>${escapeHtml(nameFor(state.players, id))}</span></label>`).join('')}</div><p class="selected-copy" id="selected-copy">Select a player</p><button class="button primary full" type="submit">Submit vote</button></form>`
  }
  if (state.phase === 'vote-result') {
    const result = state.roundResult!; const selected = escapeHtml(nameFor(state.players, result.selectedPlayerId))
    return `<p class="eyebrow">The group chose</p><h1>${selected}</h1>${result.suspectRevealed ? `<div class="reveal-result"><p class="eyebrow">${result.selectedWasImposter ? 'Correct' : 'Incorrect'}</p><h2>${selected} was ${result.selectedWasImposter ? 'an imposter' : 'not an imposter'}.</h2></div>` : '<p class="muted">Waiting for the host to reveal the result…</p>'}`
  }
  if (state.phase === 'imposter-reveal' || state.phase === 'imposter-word-guess') return `<p class="eyebrow">The imposters ${state.revealedImposterIds.length === 1 ? 'were' : 'were'}</p><h1>${state.revealedImposterIds.map((id) => escapeHtml(nameFor(state.players, id))).join(', ')}</h1><p class="muted">${state.phase === 'imposter-word-guess' ? 'They have one collective guess.' : 'Waiting for the word guess.'}</p>`
  const result = state.roundResult!
  return `<p class="eyebrow">Round ${state.currentRoundIndex + 1} complete</p><h1>${escapeHtml(state.revealedSecretWord ?? '')}</h1><p class="muted">The secret word is revealed. Group +${result.groupPoints}; Imposters +${result.imposterPoints}.</p><div class="final-scores compact"><div><span>Group</span><strong>${state.scores.group}</strong></div><div><span>Imposters</span><strong>${state.scores.imposters}</strong></div></div><p>Waiting for the host to start the next round…</p>`
}

function renderPlayerState(state: PlayerGameState): void {
  const waiting = state.phase === 'lobby' || state.phase === 'complete'
  app.innerHTML = shell(`<section class="${waiting ? 'narrow waiting' : 'role-page'}">${playerPhaseMarkup(state)}</section>`)
  const card = document.querySelector<HTMLButtonElement>('#reveal-card')
  if (card) { const reveal = () => card.classList.add('is-revealed'); const hide = () => card.classList.remove('is-revealed'); card.addEventListener('pointerdown', (event) => { event.preventDefault(); card.setPointerCapture(event.pointerId); reveal() }); card.addEventListener('pointerup', hide); card.addEventListener('pointercancel', hide); card.addEventListener('pointerleave', hide); card.addEventListener('keydown', reveal); card.addEventListener('keyup', hide) }
  const form = document.querySelector<HTMLFormElement>('#vote-form')
  form?.addEventListener('change', () => { const selected = new FormData(form).get('candidate'); const copy = document.querySelector('#selected-copy'); if (copy && selected) copy.textContent = `Selected: ${nameFor(state.players, String(selected))}` })
  form?.addEventListener('submit', (event) => { event.preventDefault(); const selected = new FormData(form).get('candidate'); if (selected) void run(() => service.submitVote(state.code, state.player.id, String(selected))) })
}

function renderRules(): void {
  app.innerHTML = shell(`<section class="rules-page"><div class="rules-heading"><p class="eyebrow">Before you play</p><h1>Rules of the game</h1><p>One clue each. Two words max. Three rounds to find the bluff.</p></div><ol class="rules-list">${RULES.map((rule) => `<li><span>${rule}</span></li>`).join('')}</ol><div class="panel scoring-rules"><p class="eyebrow">Automatic scoring</p><p><strong>Group +1</strong> for selecting an imposter.</p><p><strong>Imposters +1</strong> when an innocent player is selected, plus one for correctly guessing the word.</p></div></section>`)
}

function renderCurrentRoute(): void {
  unsubscribe?.(); unsubscribe = null
  const [page, code, id] = route()
  if (page === 'host' && code) { unsubscribe = service.subscribeToGameState(code.toUpperCase(), null, (state) => renderHostState(state as GameRoom)); return }
  if (page === 'play' && code && id) {
    service.getGameState(code, id).then(() => { unsubscribe = service.subscribeToGameState(code.toUpperCase(), id, (state) => renderPlayerState(state as PlayerGameState)) }).catch(() => renderJoin(code.toUpperCase()))
    return
  }
  if (page === 'join') return renderJoin(code?.toUpperCase())
  if (page === 'rules') return renderRules()
  renderHome()
}

window.addEventListener('hashchange', () => { stopTimer(); renderCurrentRoute() })
app.innerHTML = shell('<section class="narrow waiting"><div class="waiting-orb"><span></span></div><p class="eyebrow">Connecting</p><h1>Connecting to the game…</h1><p class="muted">Setting up a private anonymous session.</p></section>')
service.initialize().then(renderCurrentRoute).catch((error) => {
  console.error('Firebase authentication failed.', error)
  app.innerHTML = shell('<section class="narrow waiting"><p class="eyebrow">Connection problem</p><h1>Could not connect.</h1><p class="muted">Check your internet connection and reload this page.</p><button class="button primary" onclick="location.reload()">Try again</button></section>')
})
