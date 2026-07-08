import { useEffect, useState } from 'react'

// Debounce any value so dependent effects/queries (search-as-you-type,
// suggestion lookups) don't fire on every keystroke.
export const useDebouncedValue = <T>(value: T, delayMs: number): T => {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}
