import { useEffect } from 'react'
import { isReactNativeWebView } from '../../lib/mobile-shell'

export type NativePhoneCreationAction = 'project' | 'channel' | 'message' | 'agent'

type NativePhoneCreationWindow = Window & {
  __nessieCreateFromPhoneMenu?: (action: NativePhoneCreationAction) => void
}

type NativePhoneCreationBridgeProps = {
  onCreateAgent: () => void
  onCreateChannel: () => void
  onCreateMessage: () => void
  onCreateProject: () => void
}

/**
 * The native phone action sheet deliberately calls the same shell handlers as
 * the sidebar controls, so create permissions and dialogs remain identical.
 */
export const NativePhoneCreationBridge = ({
  onCreateAgent,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
}: NativePhoneCreationBridgeProps) => {
  useEffect(() => {
    if (!isReactNativeWebView()) return undefined
    const target = window as NativePhoneCreationWindow
    target.__nessieCreateFromPhoneMenu = (action) => {
      if (action === 'project') {
        onCreateProject()
      } else if (action === 'channel') {
        onCreateChannel()
      } else if (action === 'message') {
        onCreateMessage()
      } else if (action === 'agent') {
        onCreateAgent()
      }
    }
    return () => {
      delete target.__nessieCreateFromPhoneMenu
    }
  }, [onCreateAgent, onCreateChannel, onCreateMessage, onCreateProject])

  return null
}
