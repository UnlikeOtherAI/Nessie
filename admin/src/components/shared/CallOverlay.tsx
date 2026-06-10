import { useEffect, useRef, useState } from 'react'
import { JITSI_DOMAIN, loadJitsiApi } from '../../lib/jitsi'

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    JitsiMeetExternalAPI: any
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type CallOverlayProps = {
  displayName: string
  onLeave: () => void
  roomId: string
}

export const CallOverlay = ({ roomId, displayName, onLeave }: CallOverlayProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<unknown>(null)
  const [minimized, setMinimized] = useState(false)

  useEffect(() => {
    let disposed = false

    loadJitsiApi().then(() => {
      if (disposed || !containerRef.current) return

      const api = new window.JitsiMeetExternalAPI(JITSI_DOMAIN, {
        roomName: roomId,
        parentNode: containerRef.current,
        width: '100%',
        height: '100%',
        configOverwrite: {
          startWithAudioMuted: true,
          startWithVideoMuted: true,
          disableDeepLinking: true,
          prejoinPageEnabled: false,
        },
        interfaceConfigOverwrite: {
          SHOW_JITSI_WATERMARK: false,
          SHOW_BRAND_WATERMARK: false,
          TOOLBAR_BUTTONS: [
            'microphone',
            'camera',
            'desktop',
            'chat',
            'raisehand',
            'tileview',
            'hangup',
          ],
        },
        userInfo: { displayName },
      })

      api.addEventListener('readyToClose', () => onLeave())
      apiRef.current = api
    })

    return () => {
      disposed = true
      if (apiRef.current) {
        (apiRef.current as { dispose: () => void }).dispose()
        apiRef.current = null
      }
    }
  }, [roomId])

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-[color:var(--success-border)] bg-[color:var(--main)] px-3 py-1.5 shadow-lg">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--success)] opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[color:var(--success)]" />
        </span>
        <span className="text-xs text-[color:var(--tx2)]">In call</span>
        <button
          className="text-xs text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
          onClick={() => setMinimized(false)}
          type="button"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex h-[360px] w-[480px] flex-col overflow-hidden rounded-xl border border-[color:var(--border-strong)] bg-[color:var(--main)] shadow-2xl">
      <div className="flex items-center justify-between border-b border-[color:var(--sep)] px-3 py-1.5">
        <span className="text-xs font-medium text-[color:var(--tx2)]">Video Call</span>
        <div className="flex items-center gap-1">
          <button
            className="rounded p-0.5 text-[color:var(--tx3)] hover:text-[color:var(--tx)]"
            onClick={() => setMinimized(true)}
            title="Minimize"
            type="button"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M20 12H4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="rounded p-0.5 text-[color:var(--tx3)] hover:text-[color:var(--danger-text)]"
            onClick={onLeave}
            title="Leave call"
            type="button"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M6 18L18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>
      <div ref={containerRef} className="flex-1" />
    </div>
  )
}
