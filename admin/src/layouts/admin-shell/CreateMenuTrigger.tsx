import { useRef, useState, type RefObject } from 'react'
import {
  faFolderPlus,
  faHashtag,
  faPenToSquare,
  faPlus,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../../components/overlays/Popover'
import { RailTooltip } from './RailTooltip'
import { useTransientMenu } from './TransientMenuContext'

type CreateMenuTriggerProps = {
  onCreateChannel: () => void
  onCreateMessage: () => void
  onCreateProject: () => void
}

type CreateMenuPopoverProps = CreateMenuTriggerProps & {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  open: boolean
}

const actionRowClassName = [
  'group flex w-full items-center gap-3 rounded-lg p-2 text-left',
  'transition-colors hover:bg-[color:var(--overlay-weak)] focus-visible:bg-[color:var(--overlay-weak)]',
].join(' ')

const panelClassName = [
  'w-[272px] overflow-hidden rounded-xl border',
  'border-[color:var(--sep)] bg-[color:var(--panel)] p-2',
  'shadow-[0_16px_48px_var(--scrim-strong)]',
].join(' ')

const CreateMenuPopover = ({
  anchorRef,
  onClose,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
  open,
}: CreateMenuPopoverProps) => {
  const select = (action: () => void) => {
    onClose()
    action()
  }

  return (
    <Popover
      anchorRef={anchorRef}
      className={panelClassName}
      label="Create"
      onClose={onClose}
      open={open}
      placement="right"
      role="menu"
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
    </Popover>
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
      <CreateMenuPopover
        anchorRef={buttonRef}
        onClose={close}
        onCreateChannel={onCreateChannel}
        onCreateMessage={onCreateMessage}
        onCreateProject={onCreateProject}
        open={isOpen}
      />
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
