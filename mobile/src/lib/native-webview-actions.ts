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
  runToolbarAction: (action: ToolbarAction): void => {
    runScript(`window.__nessieToolbarAction && window.__nessieToolbarAction(${JSON.stringify(action)});`)
  },
  toggleFocusMode: (): void => {
    runScript('window.__nessieToggleFocusMode && window.__nessieToggleFocusMode();')
  },
  toggleAccountMenu: (): void => {
    runScript('window.__nessieToggleAccountMenu && window.__nessieToggleAccountMenu();')
  },
  toggleWorkspaceMenu: (left: number): void => {
    runScript(`window.__nessieToggleWorkspaceMenu && window.__nessieToggleWorkspaceMenu(${JSON.stringify(left)});`)
  },
})
