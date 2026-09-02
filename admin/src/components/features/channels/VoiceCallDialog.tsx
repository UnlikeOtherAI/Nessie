import { useEffect, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  faMicrophone,
  faMicrophoneSlash,
  faPhoneSlash,
} from '@fortawesome/free-solid-svg-icons'

import { Dialog } from '../../shared/Dialog'
import type { VoiceCallState } from '../../../facades/voice/voice-call-client'

/**
 * The in-call surface: who you are talking to, what is being said, and the two
 * controls a call needs.
 *
 * Everything here reflects state the call controller owns. The dialog does not
 * hold the call — closing it would otherwise hang up by accident — so
 * dismissal is disabled while a call is live, and hanging up is an explicit
 * button.
 */

const formatElapsed = (startedAt: number | null, now: number): string => {
  if (!startedAt) return '0:00'
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`
}

const statusLabel = (state: VoiceCallState): string => {
  switch (state.phase) {
    case 'connecting':
      return 'Connecting…'
    case 'live':
      return state.assistantSpeaking ? 'Speaking' : 'Listening'
    case 'ending':
      return 'Ending call…'
    case 'failed':
      return 'Call failed'
    default:
      return 'Ready'
  }
}

export type VoiceCallDialogProps = {
  onClose: () => void
  onEnd: () => void
  onRetry: () => void
  onToggleMute: () => void
  open: boolean
  state: VoiceCallState
}

const VoiceCallDialog = ({
  onClose,
  onEnd,
  onRetry,
  onToggleMute,
  open,
  state,
}: VoiceCallDialogProps) => {
  const [now, setNow] = useState(() => Date.now())
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  // One timer for the call clock, running only while a call is up.
  useEffect(() => {
    if (state.phase !== 'live') return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [state.phase])

  // Follow the conversation as it arrives, the way a chat feed does.
  useEffect(() => {
    const node = transcriptRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [state.transcript.length, state.liveUserText, state.liveAssistantText])

  const live = state.phase === 'live' || state.phase === 'connecting'
  const agentName = state.agentName ?? 'Personal Assistant'

  return (
    <Dialog
      description={live ? `${statusLabel(state)} · ${formatElapsed(state.startedAt, now)}` : statusLabel(state)}
      dismissDisabled={live}
      onClose={onClose}
      open={open}
      title={`Call with ${agentName}`}
    >
      <div className="grid gap-5">
        {state.error ? (
          <p className="text-sm" style={{ color: 'var(--danger-text)' }}>
            {state.error}
          </p>
        ) : null}

        <div
          aria-label="Call transcript"
          aria-live="polite"
          className="grid gap-3 overflow-y-auto"
          ref={transcriptRef}
          style={{ maxHeight: '18rem', minHeight: '6rem' }}
        >
          {state.transcript.length === 0
          && !state.liveUserText
          && !state.liveAssistantText ? (
            <p className="text-sm" style={{ color: 'var(--tx3)' }}>
              {state.phase === 'connecting'
                ? 'Setting up the line…'
                : 'Say something to get started.'}
            </p>
          ) : null}

          {state.transcript.map((line, index) => (
            <div className="grid gap-1" key={`${line.atMs}-${index}`}>
              <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--tx3)' }}>
                {line.speaker === 'user' ? 'You' : agentName}
              </span>
              <span className="text-sm" style={{ color: 'var(--tx)' }}>
                {line.text}
              </span>
            </div>
          ))}

          {/* In-flight speech, shown dimmed so it reads as not-yet-final. */}
          {state.liveUserText ? (
            <div className="grid gap-1">
              <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--tx3)' }}>
                You
              </span>
              <span className="text-sm" style={{ color: 'var(--tx2)' }}>
                {state.liveUserText}
              </span>
            </div>
          ) : null}
          {state.liveAssistantText ? (
            <div className="grid gap-1">
              <span className="text-xs uppercase tracking-wide" style={{ color: 'var(--tx3)' }}>
                {agentName}
              </span>
              <span className="text-sm" style={{ color: 'var(--tx2)' }}>
                {state.liveAssistantText}
              </span>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2">
          {state.phase === 'failed' ? (
            <button className="admin-button" onClick={onRetry} type="button">
              Try again
            </button>
          ) : null}
          {live ? (
            <>
              <button
                aria-pressed={state.muted}
                className="admin-button admin-button-secondary"
                onClick={onToggleMute}
                type="button"
              >
                <FontAwesomeIcon icon={state.muted ? faMicrophoneSlash : faMicrophone} />
                <span className="ml-2">{state.muted ? 'Unmute' : 'Mute'}</span>
              </button>
              <button className="admin-button admin-button-danger" onClick={onEnd} type="button">
                <FontAwesomeIcon icon={faPhoneSlash} />
                <span className="ml-2">End call</span>
              </button>
            </>
          ) : (
            <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
              Close
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

export default VoiceCallDialog
