import { registerViewportMediaQuery, useViewport } from '../hooks/useViewport'

// Navigation reads the reduced-motion preference in JS: every scripted
// transition (a stack slide, an overlay's open and close) still runs through
// the same path at 0 ms, settles and commits, rather than being skipped.
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
registerViewportMediaQuery('reducedMotion', REDUCED_MOTION_QUERY)

export const useReducedMotion = (): boolean => useViewport().media?.reducedMotion ?? false
