import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  faFolderPlus,
  faHashtag,
  faPenToSquare,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { RailTooltip } from './RailTooltip'
import { useTransientMenu } from './TransientMenuContext'

const MENU_GAP = 8
const MENU_WIDTH = 272

type CreateMenuPosition = {
  bottom: number
  left: number
}

type CreateMenuTriggerProps = {
  onCreateChannel: () => void
  onCreateMessage: () => void
  onCreateProject: () => void
}

type CreateMenuPopoverProps = CreateMenuTriggerProps & {
  anchor: HTMLElement | null
  onClose: () => void
}

// Geometry only: this clamps a popover to the visible browser window. It does
// not decide a responsive layout or a device form factor.
const clampMenuLeft = (left: number): number =>
  Math.max(MENU_GAP, Math.min(left, window.innerWidth - MENU_WIDTH - MENU_GAP))

const actionRowClassName = [
  'group flex w-full items-center gap-3 rounded-lg p-2 text-left',
  'transition-colors hover:bg-[color:var(--overlay-weak)] focus-visible:bg-[color:var(--overlay-weak)]',
].join(' ')

const CreateMenuPopover = ({
  anchor,
  onClose,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
}: CreateMenuPopoverProps) => {
  const [position, setPosition] = useState<CreateMenuPosition | null>(null)

  useLayoutEffect(() => {
    const updatePosition = () => {
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setPosition({
        bottom: Math.max(MENU_GAP, window.innerHeight - rect.bottom),
        left: clampMenuLeft(rect.right + MENU_GAP),
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    return () => window.removeEventListener('resize', updatePosition)
  }, [anchor])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (!position) return null

  const select = (action: () => void) => {
    onClose()
    action()
  }

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <section
        aria-label="Create"
        className={[
          'fixed z-[61] w-[272px] overflow-hidden rounded-xl border',
          'border-[color:var(--sep)] bg-[color:var(--panel)] p-2',
          'shadow-[0_16px_48px_var(--scrim-strong)]',
        ].join(' ')}
        style={position}
      >
        <h2 className="px-1.5 pb-2 pt-1 text-sm font-semibold text-[color:var(--tx)]">Create</h2>
        <button className={actionRowClassName} onClick={() => select(onCreateMessage)} type="button">
          <span className="create-menu-icon create-menu-icon-message" aria-hidden="true">
            <FontAwesomeIcon icon={faPenToSquare} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[color:var(--tx)]">Message</span>
            <span className="block text-xs text-[color:var(--tx3)]">Start a new direct message</span>
          </span>
        </button>
        <button className={actionRowClassName} onClick={() => select(onCreateChannel)} type="button">
          <span className="create-menu-icon create-menu-icon-channel" aria-hidden="true">
            <FontAwesomeIcon icon={faHashtag} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[color:var(--tx)]">Channel</span>
            <span className="block text-xs text-[color:var(--tx3)]">Start a group conversation</span>
          </span>
        </button>
        <button className={actionRowClassName} onClick={() => select(onCreateProject)} type="button">
          <span className="create-menu-icon create-menu-icon-project" aria-hidden="true">
            <FontAwesomeIcon icon={faFolderPlus} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[color:var(--tx)]">Project</span>
            <span className="block text-xs text-[color:var(--tx3)]">Organise work in a shared space</span>
          </span>
        </button>
      </section>
    </>
  )
}

// The native phone sheet and this desktop/web menu both call the shell's
// creation handlers. The presentation changes by device; the action boundary
// and authorization do not.
export const CreateMenuTrigger = ({
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
}: CreateMenuTriggerProps) => {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { close, isOpen, toggle } = useTransientMenu()
  const [tooltipOpen, setTooltipOpen] = useState(false)

  const showTooltip = () => {
    if (!isOpen) setTooltipOpen(true)
  }

  const toggleMenu = () => {
    setTooltipOpen(false)
    toggle()
  }

  return (
    <>
      <button
        aria-describedby={tooltipOpen ? 'create-menu-tooltip' : undefined}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Create new"
        className={[
          'admin-rail-create-trigger',
          isOpen ? 'is-open' : '',
        ].join(' ')}
        onBlur={() => setTooltipOpen(false)}
        onClick={toggleMenu}
        onFocus={showTooltip}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltipOpen(false)}
        ref={buttonRef}
        type="button"
      >
        <FontAwesomeIcon aria-hidden="true" icon={faPlus} />
      </button>
      {isOpen ? (
        <CreateMenuPopover
          anchor={buttonRef.current}
          onClose={close}
          onCreateChannel={onCreateChannel}
          onCreateMessage={onCreateMessage}
          onCreateProject={onCreateProject}
        />
      ) : null}
      <RailTooltip
        anchorRef={buttonRef}
        description="Start a message, channel, or project."
        id="create-menu-tooltip"
        open={tooltipOpen}
        title="Create new"
      />
    </>
  )
}
