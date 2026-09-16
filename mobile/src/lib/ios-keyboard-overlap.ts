import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'
import { keyboardOverlapHeight } from './keyboard-overlap'

/**
 * The keyboard's overlap with the window on iOS, kept current as it moves.
 * See keyboard-overlap.ts for why the WebView frame, not the page, owns it.
 */
export const useIosKeyboardOverlap = (windowHeight: number): number => {
  const [overlap, setOverlap] = useState(0)

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined
    // "Will" events land as the keyboard starts moving, so the frame changes
    // with the keyboard rather than one animation behind it. A floating or
    // undocked iPad keyboard reports a top edge at the window bottom → 0.
    const frame = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
      setOverlap(keyboardOverlapHeight(windowHeight, event.endCoordinates.screenY))
    })
    const hide = Keyboard.addListener('keyboardWillHide', () => setOverlap(0))
    return () => {
      frame.remove()
      hide.remove()
    }
  }, [windowHeight])

  return overlap
}
