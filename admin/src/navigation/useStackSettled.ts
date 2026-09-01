import { useSyncExternalStore } from 'react'
import { isStackTransitioning, subscribeStackTransition } from './transition-state'

// True while no stack transition is in flight. A screen that must act after
// its slide has landed — focus its heading, open the keyboard, slide a card
// in — renders on this rather than guessing at a timer, so the rule "nothing
// moves during a transition" holds for every caller.
//
// Rulebook: docs/navigation.md §4.
export const useStackSettled = (): boolean =>
  useSyncExternalStore(
    subscribeStackTransition,
    () => !isStackTransitioning(),
    () => true,
  )
