import QRCode from 'qrcode'
import './style.css'
import { GAME_CONFIG } from './config/gameConfig'
import { getImposterCount } from './domain/gameLogic'
import { createTimer, resetTimer, startTimer, tickTimer, type TimerState } from './domain/timer'
import type { GameRoom, Player, ScoreEvent } from './domain/types'
import { RULES } from './rules'
import { buildJoinUrl } from './routing'
import { LocalGameService } from './services/LocalGameService'

const app = document.querySelector<HTMLDivElement>('#app')!
const service = new LocalGameService()
let timer: TimerState = createTimer(GAME_CONFIG.discussionSeconds)
let timerInterval: number | undefined

const escapeHtml = (value: string): string => {
  const element = document.createElement('div')
  element.textContent = value
  return element.innerHTML
}

function route(): string[] {
  return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
}

function navigate(path: string): void {
  location.hash = path
}

function shell(content: string, options: { compact?: boolean } = {}): string {
  return `
    <div class="ambient ambient-one"></div><div class="ambient ambient-two"></div>
    <header class="topbar ${options.compact ? 'topbar-compact' : ''}">
      <a class="brand" href="#/" aria-label="Imposter Game home"><span class="brand-mark">I?</span><span>Imposter Game</span></a>
      <a class="text-link" href="#/rules">Rules</a>
    </header>
    <main>${content}</main>
    <footer>Three rounds. One word. Trust no clue.</footer>`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

function showToast(message: string, kind: 'error' | 'success' = 'error'): void {
  const toast = document.createElement('div')
  toast.className = `toast ${kind}`
  toast.textContent = message
  document.body.append(toast)
  setTimeout(() => toast.remove(), 3200)
}

async function renderHome(): Promise<void> {
  app.innerHTML = shell(`
    <section class="hero">
      <p class="eyebrow">A three-round party game</p>
      <h1>Know the word.<br><span>Hide the truth.</span></h1>
      <p class="hero-copy">Give a clever clue, spot the bluff, and unmask the imposters before they guess the secret.</p>
      <div class="action-stack">
        <button class="button primary" id="create-game">Host a game <span>→</span></button>
        <button class="button secondary" id="join-game">Join with a code</button>
      </div>
      <p class="demo-note"><span class="dot"></span> Demo mode stores one game on this device only</p>
    </section>
    <section class="how-it-works">
      <p class="eyebrow">How it works</p>
      <div class="steps">
        <article><strong>01</strong><h2>Get your role</h2><p>Most players see the word. Imposters see only the category.</p></article>
        <article><strong>02</strong><h2>Give one clue</h2><p>Use two words or fewer. Prove you know it without giving it away.</p></article>
        <article><strong>03</strong><h2>Find the bluff</h2><p>Discuss, vote, reveal—and see if the imposters can steal the point.</p></article>
      </div>
    </section>`)
  document.querySelector('#create-game')?.addEventListener('click', async () => {
    const room = await service.createRoom()
    navigate(`/host/${room.code}`)
  })
  document.querySelector('#join-game')?.addEventListener('click', () => navigate('/join'))
}

function renderJoin(code = ''): void {
  app.innerHTML = shell(`
    <section class="narrow card-page">
      <a href="#/" class="back-link">← Back home</a>
      <div class="panel join-panel">
        <p class="eyebrow">Join the game</p>
        <h1>Your seat is waiting.</h1>
        <p class="muted">In this demo, the room must have been created in this same browser.</p>
        <form id="join-form">
          <label for="room-code">Room code</label>
          <input id="room-code" name="code" value="${escapeHtml(code)}" maxlength="5" autocomplete="off" required placeholder="ABCDE">
          <label for="nickname">Nickname</label>
          <input id="nickname" name="name" maxlength="24" autocomplete="nickname" required placeholder="What should we call you?">
          <button class="button primary" type="submit">Join room <span>→</span></button>
        </form>
      </div>
    </section>`)
  const form = document.querySelector<HTMLFormElement>('#join-form')!
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    try {
      const room = await service.joinRoom(String(data.get('code')), String(data.get('name')))
      const player = room.players.at(-1)!
      sessionStorage.setItem(`imposter-game:player:${room.code}`, player.id)
      navigate(`/play/${room.code}/${player.id}`)
    } catch (error) {
      showToast(errorMessage(error))
    }
  })
}

function playerList(players: Player[], removable: boolean): string {
  if (!players.length) return '<div class="empty-state">No players yet. Add demo players below.</div>'
  return `<ul class="player-list">${players.map((player, index) => `
    <li><span class="player-number">${String(index + 1).padStart(2, '0')}</span><span>${escapeHtml(player.name)}</span>
      ${removable ? `<button class="icon-button remove-player" data-player="${player.id}" aria-label="Remove ${escapeHtml(player.name)}">×</button>` : ''}
    </li>`).join('')}</ul>`
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function stopTimer(): void {
  if (timerInterval !== undefined) window.clearInterval(timerInterval)
  timerInterval = undefined
}

function timerMarkup(): string {
  return `<div class="timer-card ${timer.remaining === 0 ? 'timer-done' : ''}">
    <p class="eyebrow">Discussion timer</p>
    <div class="timer-value" id="timer-value">${formatTimer(timer.remaining)}</div>
    <div class="button-row">
      <button class="button primary" id="timer-toggle">${timer.running ? 'Pause' : timer.remaining === 0 ? 'Time’s up' : 'Start timer'}</button>
      <button class="button secondary" id="timer-reset">Reset</button>
    </div>
  </div>`
}

async function renderHost(code: string): Promise<void> {
  const room = await service.getRoom(code)
  if (!room) {
    app.innerHTML = shell('<section class="narrow card-page"><div class="panel"><h1>Room not found</h1><p class="muted">This demo room only exists in the browser where it was created.</p><a class="button primary" href="#/">Go home</a></div></section>')
    return
  }
  const round = GAME_CONFIG.rounds[room.currentRoundIndex]
  const joinUrl = buildJoinUrl(location.origin, import.meta.env.BASE_URL, room.code)
  app.innerHTML = shell(`
    <section class="host-layout">
      <div class="host-header">
        <div><p class="eyebrow">Host dashboard · local demo</p><h1>${room.status === 'lobby' ? 'Gather your players.' : room.status === 'complete' ? 'Game complete.' : `Round ${round.number} · ${escapeHtml(round.category)}`}</h1></div>
        <div class="room-code"><span>Room code</span><strong>${room.code}</strong></div>
      </div>
      <div class="demo-banner"><strong>Same-device demo:</strong> this room is not shared over the internet. Use “Add demo player” or open the join link in this browser to test the flow.</div>
      ${room.status === 'lobby' ? lobbyMarkup(room, joinUrl) : room.status === 'complete' ? completeMarkup(room) : roundMarkup(room)}
    </section>`, { compact: true })
  bindHostEvents(room, joinUrl)
}

function lobbyMarkup(room: GameRoom, joinUrl: string): string {
  return `<div class="dashboard-grid">
    <section class="panel players-panel">
      <div class="section-heading"><div><p class="eyebrow">Players</p><h2>${room.players.length} / ${GAME_CONFIG.maxPlayers} joined</h2></div>${room.players.length ? `<span class="pill">${getImposterCount(room.players.length)} imposter${getImposterCount(room.players.length) > 1 ? 's' : ''}</span>` : ''}</div>
      ${playerList(room.players, true)}
      <form id="demo-player-form" class="inline-form"><input name="name" maxlength="24" required placeholder="Demo player name"><button class="button secondary" type="submit">Add demo player</button></form>
      <button class="button primary full" id="start-round" ${room.players.length === 0 ? 'disabled' : ''}>Start Round 1 <span>→</span></button>
    </section>
    <aside class="panel invite-panel">
      <p class="eyebrow">Join link preview</p><div id="qr-code" class="qr-code" aria-label="QR code for join URL"></div>
      <p class="join-url">${escapeHtml(joinUrl)}</p>
      <button class="button secondary full" id="copy-link">Copy link</button>
      <p class="fine-print">The QR is ready, but it will only work across phones after a backend is connected.</p>
    </aside>
  </div>`
}

function roundMarkup(room: GameRoom): string {
  const round = GAME_CONFIG.rounds[room.currentRoundIndex]
  const imposters = room.players.filter((player) => room.imposterIds.includes(player.id))
  const isRevealed = room.status === 'revealed'
  return `<div class="dashboard-grid">
    <section class="panel round-panel">
      <div class="round-strip"><span>Round ${round.number} of ${GAME_CONFIG.rounds.length}</span><span>${escapeHtml(round.category)}</span></div>
      <p class="eyebrow">Private role previews</p>
      <h2>Pass the device carefully.</h2>
      <p class="muted">Open a player card, then let that player hold to reveal their own assignment.</p>
      <div class="role-links">${room.players.map((player) => `<a class="player-role-link" href="#/play/${room.code}/${player.id}"><span>${escapeHtml(player.name)}</span><span>View role →</span></a>`).join('')}</div>
      ${isRevealed ? `<div class="reveal-result"><p class="eyebrow">The imposter${imposters.length > 1 ? 's were' : ' was'}</p><h2>${imposters.map((player) => escapeHtml(player.name)).join(', ')}</h2><button class="secret-toggle text-link" type="button">Reveal secret word</button><strong class="secret-word hidden">${escapeHtml(round.secretWord)}</strong></div>` : ''}
    </section>
    <aside class="host-controls">
      ${timerMarkup()}
      <div class="panel score-card"><p class="eyebrow">Score</p><div class="score-line"><span>Group</span><strong>${room.scores.group}</strong></div><div class="score-line"><span>Imposters</span><strong>${room.scores.imposters}</strong></div>
      ${isRevealed ? `<div class="score-actions"><button data-score="group-found-imposter">Group found one +1</button><button data-score="group-picked-normal">Voted for normal +1</button><button data-score="imposters-guessed-word">Correct word guess +1</button></div>` : '<p class="fine-print">Scoring controls appear after the reveal.</p>'}</div>
      ${isRevealed ? `<button class="button primary full" id="advance-round">${room.currentRoundIndex === GAME_CONFIG.rounds.length - 1 ? 'Finish game' : `Start Round ${round.number + 1}`} <span>→</span></button>` : '<button class="button danger full" id="reveal-imposters">Reveal imposters</button>'}
    </aside>
  </div>`
}

function completeMarkup(room: GameRoom): string {
  const comparison = room.scores.group === room.scores.imposters ? 'The scores are tied.' : room.scores.group > room.scores.imposters ? 'The group has the higher score.' : 'The imposters have the higher score.'
  return `<section class="panel finale"><p class="eyebrow">Final score</p><h2>That’s all three rounds.</h2><div class="final-scores"><div><span>Group</span><strong>${room.scores.group}</strong></div><div><span>Imposters</span><strong>${room.scores.imposters}</strong></div></div><p class="result-copy">${comparison}</p><button class="button primary" id="reset-game">Reset with same players</button></section>`
}

function bindTimerEvents(): void {
  document.querySelector('#timer-toggle')?.addEventListener('click', () => {
    if (timer.running) {
      timer = { ...timer, running: false }
      stopTimer()
      void renderCurrentRoute()
      return
    }
    timer = startTimer(timer)
    if (!timer.running) return
    timerInterval = window.setInterval(() => {
      timer = tickTimer(timer)
      const display = document.querySelector('#timer-value')
      if (display) display.textContent = formatTimer(timer.remaining)
      if (!timer.running) {
        stopTimer()
        void renderCurrentRoute()
      }
    }, 1000)
    void renderCurrentRoute()
  })
  document.querySelector('#timer-reset')?.addEventListener('click', () => {
    stopTimer()
    timer = resetTimer(GAME_CONFIG.discussionSeconds)
    void renderCurrentRoute()
  })
}

function bindHostEvents(room: GameRoom, joinUrl: string): void {
  if (room.status === 'lobby') {
    const qrCanvas = document.createElement('canvas')
    QRCode.toCanvas(qrCanvas, joinUrl, { width: 196, margin: 1, color: { dark: '#161622', light: '#ffffff' } })
      .then(() => document.querySelector('#qr-code')?.append(qrCanvas))
      .catch(() => showToast('Could not draw the QR preview.'))
    document.querySelector('#copy-link')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(joinUrl)
      showToast('Join link copied.', 'success')
    })
    document.querySelector<HTMLFormElement>('#demo-player-form')?.addEventListener('submit', async (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const name = new FormData(form).get('name')
      try { await service.joinRoom(room.code, String(name)); await renderHost(room.code) }
      catch (error) { showToast(errorMessage(error)) }
    })
    document.querySelectorAll<HTMLButtonElement>('.remove-player').forEach((button) => button.addEventListener('click', async () => {
      await service.removePlayer(room.code, button.dataset.player!)
      await renderHost(room.code)
    }))
    document.querySelector('#start-round')?.addEventListener('click', async () => {
      try { await service.startRound(room.code); timer = resetTimer(GAME_CONFIG.discussionSeconds); await renderHost(room.code) }
      catch (error) { showToast(errorMessage(error)) }
    })
  }
  if (room.status === 'round' || room.status === 'revealed') bindTimerEvents()
  document.querySelector('#reveal-imposters')?.addEventListener('click', async () => {
    await service.revealRound(room.code); await renderHost(room.code)
  })
  document.querySelector('.secret-toggle')?.addEventListener('click', (event) => {
    const word = document.querySelector('.secret-word')
    word?.classList.toggle('hidden')
    ;(event.currentTarget as HTMLButtonElement).textContent = word?.classList.contains('hidden') ? 'Reveal secret word' : 'Hide secret word'
  })
  document.querySelectorAll<HTMLButtonElement>('[data-score]').forEach((button) => button.addEventListener('click', async () => {
    await service.recordScore(room.code, button.dataset.score as ScoreEvent); await renderHost(room.code)
  }))
  document.querySelector('#advance-round')?.addEventListener('click', async () => {
    await service.advanceRound(room.code); timer = resetTimer(GAME_CONFIG.discussionSeconds); await renderHost(room.code)
  })
  document.querySelector('#reset-game')?.addEventListener('click', async () => {
    await service.resetGame(room.code); timer = resetTimer(GAME_CONFIG.discussionSeconds); await renderHost(room.code)
  })
}

async function renderPlayer(code: string, playerId: string): Promise<void> {
  const room = await service.getRoom(code)
  const player = room?.players.find((item) => item.id === playerId)
  if (!room || !player) { renderJoin(code); return }
  if (room.status === 'lobby') {
    app.innerHTML = shell(`<section class="narrow waiting"><div class="waiting-orb"><span></span></div><p class="eyebrow">You’re in, ${escapeHtml(player.name)}</p><h1>Waiting for the host…</h1><p class="muted">Keep this page open. In the local demo, refresh after the host starts the round.</p><button class="button secondary" id="check-game">Check for update</button></section>`)
    document.querySelector('#check-game')?.addEventListener('click', () => void renderPlayer(code, playerId))
    return
  }
  if (room.status === 'complete') {
    app.innerHTML = shell(`<section class="narrow waiting"><p class="eyebrow">Game complete</p><h1>Thanks for playing, ${escapeHtml(player.name)}.</h1><div class="final-scores compact"><div><span>Group</span><strong>${room.scores.group}</strong></div><div><span>Imposters</span><strong>${room.scores.imposters}</strong></div></div></section>`)
    return
  }
  const assignment = await service.getAssignment(code, playerId)
  app.innerHTML = shell(`<section class="role-page">
    <div class="role-intro"><p class="eyebrow">Round ${assignment.roundNumber} · ${escapeHtml(player.name)}</p><h1>Your role is private.</h1><p>Make sure only you can see the screen, then press and hold.</p></div>
    <button class="reveal-card" id="reveal-card" aria-label="Hold to reveal your role">
      <div class="role-covered"><span class="fingerprint">◎</span><strong>Hold to reveal</strong><small>Release to hide</small></div>
      <div class="role-revealed">
        <span class="role-label">Category</span><strong class="category">${escapeHtml(assignment.category)}</strong>
        ${assignment.isImposter ? '<div class="divider"></div><span class="role-label warning">You are an imposter</span><p>You do not know the secret word.</p><small>Listen carefully. Blend in. Figure it out.</small>' : `<div class="divider"></div><span class="role-label">Your word</span><strong class="secret">${escapeHtml(assignment.secretWord!)}</strong><small>Keep this screen private.</small>`}
      </div>
    </button>
    <p class="round-status">${room.status === 'revealed' ? 'The host has revealed this round.' : 'Release the card before passing the phone.'}</p>
    <a class="text-link" href="#/host/${code}">Return to host demo</a>
  </section>`)
  const card = document.querySelector<HTMLButtonElement>('#reveal-card')!
  const reveal = () => card.classList.add('is-revealed')
  const hide = () => card.classList.remove('is-revealed')
  card.addEventListener('pointerdown', (event) => { event.preventDefault(); card.setPointerCapture(event.pointerId); reveal() })
  card.addEventListener('pointerup', hide)
  card.addEventListener('pointercancel', hide)
  card.addEventListener('pointerleave', hide)
  card.addEventListener('keydown', (event) => { if (event.code === 'Space' || event.code === 'Enter') reveal() })
  card.addEventListener('keyup', hide)
}

function renderRules(): void {
  app.innerHTML = shell(`<section class="rules-page"><div class="rules-heading"><p class="eyebrow">Before you play</p><h1>Rules of the game</h1><p>One clue each. Two words max. Three rounds to find the bluff.</p></div><ol class="rules-list">${RULES.map((rule) => `<li><span>${rule}</span></li>`).join('')}</ol><div class="panel scoring-rules"><p class="eyebrow">Optional scoring</p><h2>Keep it simple.</h2><p><strong>Group +1</strong> for correctly voting for an imposter.</p><p><strong>Imposters +1</strong> when the group votes for a normal player.</p><p><strong>Imposters +1</strong> for correctly guessing the secret word.</p></div></section>`)
}

async function renderCurrentRoute(): Promise<void> {
  const [page, code, id] = route()
  if (page === 'host' && code) return renderHost(code.toUpperCase())
  if (page === 'join') return renderJoin(code?.toUpperCase())
  if (page === 'play' && code && id) return renderPlayer(code.toUpperCase(), id)
  if (page === 'rules') return renderRules()
  return renderHome()
}

window.addEventListener('hashchange', () => { stopTimer(); void renderCurrentRoute() })
window.addEventListener('imposter-game:changed', () => {
  const [page] = route()
  if (page === 'play') void renderCurrentRoute()
})
void renderCurrentRoute()
