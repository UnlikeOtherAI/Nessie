import { useMemo, useState } from 'react'

import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { buildSessionDebugDump } from '../../lib/session-debug-export'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * Advanced › Session debug: the signed-in session as JSON — the token and its
 * decoded claims, every localStorage and cookie value — to copy for somebody
 * debugging what this person sees, or to paste into another device's sign-in
 * screen. It was a dialog behind the avatar menu's Debug row; it is a page of
 * Advanced now, and still only ever shows the reader their own session.
 */
export const SessionDebugPage = () => {
  const { me } = useAuthSession()
  const [copied, setCopied] = useState(false)
  const dump = useMemo(() => buildSessionDebugDump(me), [me])

  const copy = () => {
    void navigator.clipboard
      .writeText(dump)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <SettingsPanel
      actions={[{
        id: 'copy-session-debug',
        fixedWidth: '10rem',
        label: copied ? 'Copied' : 'Copy to clipboard',
        onSelect: copy,
        primary: true,
        priority: 100,
      }]}
      eyebrow="Advanced"
      subtitle={
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
          Token, decoded claims, localStorage and cookies. Sensitive — only share with people
          you trust.
        </p>
      }
      title="Session debug"
    >
      <textarea
        aria-label="Session debug JSON"
        autoCapitalize="off"
        autoCorrect="off"
        className="admin-input admin-input-mono min-h-[60dvh] w-full"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        spellCheck={false}
        style={{ resize: 'vertical', whiteSpace: 'pre', overflowWrap: 'normal' }}
        value={dump}
      />
    </SettingsPanel>
  )
}
