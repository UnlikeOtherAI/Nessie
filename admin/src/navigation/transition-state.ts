// One framework-free signal for "a stack transition is in flight". The
// navigation stack marks the start and end of every scripted transition here;
// anything that must not run mid-slide waits on it: a data-arrival redirect
// (controller.redirect), focus after settle (useStackSettled), a card that
// wants to slide in. Kept React-independent so the stack, the controller and
// tests share one instance without a provider.
//
// Rulebook: docs/navigation/overview.md §4.

type Listener = () => void

let activeTransitions = 0
const listeners = new Set<Listener>()
let settledResolvers: Array<() => void> = []

const notify = (): void => {
  for (const listener of listeners) listener()
  if (activeTransitions === 0) {
    const resolvers = settledResolvers
    settledResolvers = []
    for (const resolve of resolvers) resolve()
  }
}

// Marks a transition as running; the returned function ends it. Ending twice
// is harmless, so a caller can end on both the animation's finish and its
// fallback timer without bookkeeping.
export const beginStackTransition = (): (() => void) => {
  activeTransitions += 1
  notify()
  let ended = false
  return () => {
    if (ended) return
    ended = true
    activeTransitions = Math.max(0, activeTransitions - 1)
    notify()
  }
}

export const isStackTransitioning = (): boolean => activeTransitions > 0

// Resolves once no transition is running — immediately when none is.
export const whenStackSettled = (): Promise<void> => {
  if (activeTransitions === 0) return Promise.resolve()
  return new Promise((resolve) => {
    settledResolvers.push(resolve)
  })
}

export const subscribeStackTransition = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Test-only: forget every in-flight transition and waiter.
export const __resetStackTransitionState = (): void => {
  activeTransitions = 0
  settledResolvers = []
  listeners.clear()
}
