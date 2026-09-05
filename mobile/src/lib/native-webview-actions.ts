import type { ToolbarAction } from '../components/IpadNativeToolbar'
import type { NativePhoneCreationAction } from './native-shell-layout'

type RunScript = (script: string) => void

export const createNativeWebviewActions = (runScript: RunScript) => ({
  closeTransientMenus: (): void => {
    runScript('window.__nessieCloseTransientMenus && window.__nessieCloseTransientMenus();')
  },
  closeSearchOverlay: (): void => {
    runScript("window.dispatchEvent(new Event('nessie:close-search-overlay'));")
  },
  createFromPhoneMenu: (action: NativePhoneCreationAction): void => {
    runScript(`window.__nessieCreateFromPhoneMenu && window.__nessieCreateFromPhoneMenu(${JSON.stringify(action)});`)
  },
  openSearchOverlay: (): void => {
    runScript("window.dispatchEvent(new Event('nessie:open-search-overlay'));")
  },
  // The bar's Back is the screen header's own, not the route resolver's: a
  // Flow that owns its Back returns to an address the registry cannot name.
  runScreenBarBack: (): void => {
    runScript('window.__nessieScreenBarBack && window.__nessieScreenBarBack();')
  },
  runToolbarAction: (action: ToolbarAction): void => {
    runScript(`window.__nessieToolbarAction && window.__nessieToolbarAction(${JSON.stringify(action)});`)
  },
  toggleFocusMode: (): void => {
    runScript('window.__nessieToggleFocusMode && window.__nessieToggleFocusMode();')
  },
  toggleAccountMenu: (): void => {
    runScript('window.__nessieToggleAccountMenu && window.__nessieToggleAccountMenu();')
  },
  toggleTeamMenu: (left: number): void => {
    runScript(`window.__nessieToggleTeamMenu && window.__nessieToggleTeamMenu(${JSON.stringify(left)});`)
  },
})
