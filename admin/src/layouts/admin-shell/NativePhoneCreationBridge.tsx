import { useEffect } from 'react'
import { isReactNativeWebView } from '../../lib/mobile-shell'

export type NativePhoneCreationAction = 'project' | 'channel' | 'message'

type NativePhoneCreationWindow = Window & {
  __nessieCreateFromPhoneMenu?: (action: NativePhoneCreationAction) => void
}

type NativePhoneCreationBridgeProps = {
  onCreateChannel: () => void
  onCreateMessage: () => void
  onCreateProject: () => void
}

/**
 * The native phone action sheet deliberately calls the same shell handlers as
 * the sidebar controls, so create permissions and dialogs remain identical.
 */
export const NativePhoneCreationBridge = ({
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
      }
    }
    return () => {
      delete target.__nessieCreateFromPhoneMenu
    }
  }, [onCreateChannel, onCreateMessage, onCreateProject])

  return null
}
