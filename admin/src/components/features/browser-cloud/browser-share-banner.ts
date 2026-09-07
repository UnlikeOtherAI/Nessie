import { useState } from 'react'

const keyFor = (agentId: string): string => `nessie.browserShareBanner.${agentId}`

/** Client-local dismissal for the shared-browser reminder. */
export const useBrowserShareBanner = (agentId: string | undefined) => {
  const [dismissed, setDismissed] = useState(() => {
    if (!agentId) return true
    try { return window.localStorage.getItem(keyFor(agentId)) === 'dismissed' } catch { return false }
  })
  const dismiss = () => {
    setDismissed(true)
    if (!agentId) return
    try { window.localStorage.setItem(keyFor(agentId), 'dismissed') } catch { /* show it next time */ }
  }
  return { dismiss, dismissed }
}
