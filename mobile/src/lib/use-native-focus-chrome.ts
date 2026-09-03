import { useEffect, useRef, useState } from 'react'

import {
  applyNativeFocusChrome,
  blendNativeChrome,
  nativeChromeKey,
  pickNativeChrome,
  type NativeChromeColors,
} from '../components/native-focus-chrome'
import { FOCUS_CHROME_DURATION_MS, easeStandard } from './chrome-transition'
import type { NativeShellPresentation } from '../components/native-shell-presentation'

/**
 * Run the native chrome to focus mode's palette on the page's own curve.
 *
 * The colours have to arrive as plain strings: the header, the iPad chrome and
 * the native tab controller all take colour props rather than animated nodes,
 * so there is nothing to hand an `Animated.Value` to. Stepping the interpolated
 * strings per frame is what makes all three move together.
 *
 * Only the chrome colours travel. Everything else on the presentation --
 * badges, toolbar state, the account, and the page-supplied `background` --
 * passes straight through, so a badge arriving mid-transition is not held back
 * by it.
 */
export const useNativeFocusChrome = (
  presentation: NativeShellPresentation,
): NativeShellPresentation => {
  const target = applyNativeFocusChrome(presentation)
  const targetChrome = pickNativeChrome(target)
  const targetKey = nativeChromeKey(targetChrome)

  const [shown, setShown] = useState<NativeChromeColors>(targetChrome)
  // What is on screen right now, so a toggle part-way through the previous
  // transition starts from the colour actually being shown rather than
  // jumping back to the palette it set out from.
  const shownRef = useRef<NativeChromeColors>(targetChrome)
  const targetRef = useRef<NativeChromeColors>(targetChrome)
  targetRef.current = targetChrome

  useEffect(() => {
    const from = shownRef.current
    const to = targetRef.current
    if (nativeChromeKey(from) === targetKey) return undefined

    let frame = 0
    const started = Date.now()
    const step = (): void => {
      const elapsed = (Date.now() - started) / FOCUS_CHROME_DURATION_MS
      const progress = Math.min(1, elapsed)
      const next = blendNativeChrome(from, to, easeStandard(progress))
      shownRef.current = next
      setShown(next)
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [targetKey])

  return { ...target, ...shown }
}
