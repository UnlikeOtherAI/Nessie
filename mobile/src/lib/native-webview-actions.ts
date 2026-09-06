import type { ToolbarAction } from '../components/IpadNativeToolbar'
import type { NativeCreationAction } from './native-shell-layout'

type RunScript = (script: string) => void

export const createNativeWebviewActions = (runScript: RunScript) => ({
  closeTransientMenus: (): void => {
    runScript('window.__nessieCloseTransientMenus && window.__nessieCloseTransientMenus();')
  },
  closeSearchOverlay: (): void => {
    runScript("window.dispatchEvent(new Event('nessie:close-search-overlay'));")
  },
  // The wire name stays `__nessieCreateFromPhoneMenu`: installed builds speak
  // it, and the control it belongs to is no longer phone-only.
  createFromNativeMenu: (action: NativeCreationAction): void => {
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
  // What an action does stays in the web: a submit action's work is in its
  // form, a toggle inverts itself, a link may leave through the shell. The bar
  // sends the id back rather than re-implementing any of that.
  runScreenBarAction: (id: string, itemId?: string): void => {
    runScript(
      `window.__nessieScreenBarAction && window.__nessieScreenBarAction(${JSON.stringify(id)}${
        itemId === undefined ? '' : `, ${JSON.stringify(itemId)}`
      });`,
    )
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
