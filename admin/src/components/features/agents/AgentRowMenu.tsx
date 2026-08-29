import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { faEllipsis } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

export type AgentRowMenuItem = {
  id: string
  label: string
  onSelect: () => void
}

type AgentRowMenuProps = {
  agentName: string
  items: AgentRowMenuItem[]
}

// `left` anchors to the button's right edge; the menu itself is shifted left by
// its own width with translateX(-100%), so it right-aligns without reading the
// viewport width (which the house lint reserves for the viewport store).
type MenuPosition = { left: number; top: number }

// The per-row ⋯ overflow menu. The dropdown is rendered through a portal with
// fixed positioning so it escapes the table card's `overflow-hidden` and the
// scroll container that would otherwise clip it — it always paints on top.
// Follows the app's menu convention (a `role="menu"` surface on `var(--main)`),
// dismissed by an outside click, Escape, or a scroll/resize that would detach it.
export const AgentRowMenu = ({ agentName, items }: AgentRowMenuProps) => {
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)

  const close = useCallback(() => setPosition(null), [])

  const open = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect()
    if (!rect) return
    setPosition({ left: rect.right, top: rect.bottom + 4 })
  }, [])

  useLayoutEffect(() => {
    if (!position) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    // A scroll or resize moves the anchor out from under a fixed menu, so close
    // rather than leave it floating in the wrong place.
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [close, position])

  return (
    <>
      <button
        aria-expanded={position !== null}
        aria-haspopup="menu"
        aria-label={`Actions for ${agentName}`}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md',
          'text-[color:var(--tx3)] transition-colors',
          'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        onClick={(event) => {
          event.stopPropagation()
          if (position) {
            close()
          } else {
            open()
          }
        }}
        ref={buttonRef}
        type="button"
      >
        <FontAwesomeIcon className="h-3.5 w-3.5" icon={faEllipsis} />
      </button>

      {position
        ? createPortal(
            <>
              <button
                aria-hidden="true"
                className="fixed inset-0 z-[60] cursor-default"
                onClick={(event) => {
                  event.stopPropagation()
                  close()
                }}
                tabIndex={-1}
                type="button"
              />
              <div
                className={[
                  'fixed z-[61] min-w-44 rounded-lg border border-[color:var(--sep)]',
                  'bg-[color:var(--main)] p-1 shadow-lg',
                ].join(' ')}
                role="menu"
                style={{
                  left: position.left,
                  top: position.top,
                  transform: 'translateX(-100%)',
                }}
              >
                {items.map((item) => (
                  <button
                    className={[
                      'flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm',
                      'text-[color:var(--tx)] transition-colors',
                      'hover:bg-[color:var(--main-hover)]',
                    ].join(' ')}
                    key={item.id}
                    onClick={(event) => {
                      event.stopPropagation()
                      close()
                      item.onSelect()
                    }}
                    role="menuitem"
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  )
}
