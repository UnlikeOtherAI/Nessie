import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'

const LONG_PRESS_MS = 450
const MOVE_TOLERANCE_PX = 10

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(
    target.closest(
      'a, button, input, select, textarea, [contenteditable="true"], [role="button"], [role="dialog"]',
    ),
  )

type ChatMessageCopyActionProps = {
  content: string
  children: (action: {
    copyAction: ReactNode
    consumeLongPressClick: () => boolean
    onContextMenu: (event: MouseEvent<HTMLElement>) => void
    onPointerCancel: () => void
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerLeave: () => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: () => void
  }) => ReactNode
  onLongPress?: () => void
}

// Text selection is disabled in chat on touch devices, so a long press exposes
// this explicit, whole-message copy action instead. Interactive descendants
// keep their own long-press behaviour (reaction details, links, and controls).
export const ChatMessageCopyAction = ({
  children,
  content,
  onLongPress,
}: ChatMessageCopyActionProps) => {
  const actionRef = useRef<HTMLDivElement>(null)
  const pressTimer = useRef<number | null>(null)
  const pressStart = useRef<{ x: number; y: number } | null>(null)
  const copiedTimer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const clearPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
    pressStart.current = null
  }

  useEffect(
    () => () => {
      clearPress()
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current)
      }
    },
  )

  useEffect(() => {
    if (!open) {
      return undefined
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!actionRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [open])

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    suppressClick.current = false
    if (event.pointerType !== 'touch' || isInteractiveTarget(event.target)) {
      return
    }

    clearPress()
    pressStart.current = { x: event.clientX, y: event.clientY }
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      pressStart.current = null
      suppressClick.current = true
      onLongPress?.()
      setCopied(false)
      setOpen(true)
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = pressStart.current
    if (!start) {
      return
    }
    if (
      Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX
    ) {
      clearPress()
    }
  }

  const copyMessage = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    void navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true)
        if (copiedTimer.current !== null) {
          window.clearTimeout(copiedTimer.current)
        }
        copiedTimer.current = window.setTimeout(() => {
          setCopied(false)
          setOpen(false)
        }, 1400)
      },
      () => setOpen(false),
    )
  }

  const copyAction = open ? (
    <div className="admin-message-copy-action" ref={actionRef} role="toolbar">
      <button
        aria-label="Copy whole message"
        className="admin-message-copy-button"
        onClick={copyMessage}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        {copied ? 'Copied' : 'Copy message'}
      </button>
    </div>
  ) : null

  return children({
    copyAction,
    consumeLongPressClick: () => {
      if (!suppressClick.current) {
        return false
      }
      suppressClick.current = false
      return true
    },
    onContextMenu: (event) => {
      if (open || suppressClick.current) {
        event.preventDefault()
      }
    },
    onPointerCancel: clearPress,
    onPointerDown,
    onPointerLeave: clearPress,
    onPointerMove,
    onPointerUp: clearPress,
  })
}
