import { useCallback, useEffect, useRef, useState } from 'react'
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

// The per-row ⋯ overflow menu. Follows the app's existing menu convention
// (WorkspaceSwitcher / ResponsivePageHeader): a `role="menu"` surface on
// `var(--main)`, dismissed by an outside click or Escape. Rows that are not
// editable (system-provided globals) simply do not render this control.
export const AgentRowMenu = ({ agentName, items }: AgentRowMenuProps) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [close, open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Actions for ${agentName}`}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md',
          'text-[color:var(--tx3)] transition-colors',
          'hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
        ].join(' ')}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
        type="button"
      >
        <FontAwesomeIcon className="h-3.5 w-3.5" icon={faEllipsis} />
      </button>

      {open ? (
        <>
          <button
            aria-hidden="true"
            className="fixed inset-0 z-40 cursor-default"
            onClick={(event) => {
              event.stopPropagation()
              close()
            }}
            tabIndex={-1}
            type="button"
          />
          <div
            className={[
              'absolute right-0 top-full z-50 mt-1 min-w-44 rounded-lg',
              'border border-[color:var(--sep)] bg-[color:var(--main)] p-1 shadow-lg',
            ].join(' ')}
            role="menu"
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
        </>
      ) : null}
    </div>
  )
}
