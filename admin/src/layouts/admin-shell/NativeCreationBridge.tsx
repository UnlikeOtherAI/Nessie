import { useEffect } from 'react'
import { isReactNativeWebView } from '../../lib/native-shell'

export type NativeCreationAction = 'project' | 'channel' | 'message' | 'agent'

// The wire name stays `__nessieCreateFromPhoneMenu`: installed shells speak
// it, and the control it drives is no longer phone-only.
type NativeCreationWindow = Window & {
  __nessieCreateFromPhoneMenu?: (action: NativeCreationAction) => void
}

type NativeCreationBridgeProps = {
  onCreateAgent: () => void
  onCreateChannel: () => void
  onCreateMessage: () => void
  onCreateProject: () => void
}

/**
 * The native creation control — the iPhone's floating action, the iPad's over
 * its channels column — deliberately calls the same shell handlers as the
 * sidebar controls, so create permissions and dialogs remain identical.
 */
export const NativeCreationBridge = ({
  onCreateAgent,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
}: NativeCreationBridgeProps) => {
  useEffect(() => {
    if (!isReactNativeWebView()) return undefined
    const target = window as NativeCreationWindow
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
