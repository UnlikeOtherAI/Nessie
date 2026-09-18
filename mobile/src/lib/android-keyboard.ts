import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

/**
 * Whether the Android soft keyboard is up.
 *
 * The iPhone needs a height (ios-keyboard-overlap.ts) because WKWebView does
 * not shorten its page for the keyboard and the shell moves the WebView frame
 * instead. Android needs only the fact: the page shortens itself to the
 * keyboard's top edge, and what the shell has to change is a decision, not a
 * measurement — the floating dock is behind the keyboard, so the page must
 * stop holding a band clear for it (see `androidDockShowing`).
 *
 * "Did", not "will": Android has no pre-animation keyboard event, and the
 * clearance this drives is a layout value rather than a frame that has to
 * travel with the keyboard.
 */
export const useAndroidKeyboardOpen = (): boolean => {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (Platform.OS !== 'android') return undefined
    const show = Keyboard.addListener('keyboardDidShow', () => setOpen(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setOpen(false))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])

  return open
}
