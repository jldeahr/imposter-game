export interface TimerState {
  remaining: number
  running: boolean
}

export const createTimer = (seconds: number): TimerState => ({ remaining: seconds, running: false })

export const startTimer = (timer: TimerState): TimerState =>
  timer.remaining > 0 ? { ...timer, running: true } : timer

export const tickTimer = (timer: TimerState): TimerState => {
  if (!timer.running || timer.remaining <= 0) return timer
  const remaining = timer.remaining - 1
  return { remaining, running: remaining > 0 }
}

export const resetTimer = (seconds: number): TimerState => createTimer(seconds)
