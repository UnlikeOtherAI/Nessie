import type { IphoneCreationAction } from '../components/IphoneConversationMenuChrome'
import type { ToolbarAction } from '../components/IpadNativeToolbar'

type RunScript = (script: string) => void

export const createNativeWebviewActions = (runScript: RunScript) => ({
  closeSearchOverlay: (): void => {
    runScript("window.dispatchEvent(new Event('nessie:close-search-overlay'));")
  },
  createFromPhoneMenu: (action: IphoneCreationAction): void => {
    runScript(`window.__nessieCreateFromPhoneMenu && window.__nessieCreateFromPhoneMenu(${JSON.stringify(action)});`)
  },
  openSearchOverlay: (): void => {
    runScript("window.dispatchEvent(new Event('nessie:open-search-overlay'));")
  },
  runToolbarAction: (action: ToolbarAction): void => {
    runScript(`window.__nessieToolbarAction && window.__nessieToolbarAction(${JSON.stringify(action)});`)
  },
  togglePhoneAccountMenu: (): void => {
    runScript('window.__nessieTogglePhoneAccountMenu && window.__nessieTogglePhoneAccountMenu();')
  },
  toggleWorkspaceMenu: (left: number): void => {
    runScript(`window.__nessieToggleWorkspaceMenu && window.__nessieToggleWorkspaceMenu(${JSON.stringify(left)});`)
  },
})
