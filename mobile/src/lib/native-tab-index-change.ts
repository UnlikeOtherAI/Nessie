import { nativeSelectTabScript } from './native-phone-navigation'
import { TABS } from './tabs'

type Input = {
  closeSearchOverlay: () => void
  closeTransientMenus: () => void
  dismissNativeMenus: () => void
  isIpad: boolean
  navigateTo: (path: string) => void
  next: number
  openSearchOverlay: () => void
  runScript: (script: string) => void
  setIndex: (index: number) => void
}

/** Keep the native tab bar's select/reselect behavior outside the shell component. */
export const applyNativeTabIndexChange = (input: Input): void => {
  input.dismissNativeMenus()
  input.closeTransientMenus()
  input.setIndex(input.next)
  if (input.isIpad && TABS[input.next]?.key === 'search') {
    input.openSearchOverlay()
    return
  }
  input.closeSearchOverlay()
  const tab = TABS[input.next]
  if (!tab) return
  if (input.isIpad) {
    input.navigateTo(tab.path)
    return
  }
  input.runScript(nativeSelectTabScript(tab.path))
}
