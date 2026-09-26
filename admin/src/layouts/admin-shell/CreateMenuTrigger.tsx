import { useRef, useState, type RefObject } from 'react'
import {
  faFolderPlus,
  faHashtag,
  faPenToSquare,
  faPlus,
  faRobot,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { Popover } from '../../components/overlays/Popover'
import { RailTooltip } from './RailTooltip'
import { useTransientMenu } from './TransientMenuContext'
import { useTranslation } from 'react-i18next'

type CreateMenuTriggerProps = {
  onCreateAgent: () => void
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
  'create-menu-panel w-[272px] overflow-hidden rounded-xl border p-2',
].join(' ')

const CreateMenuPopover = ({
  anchorRef,
  onClose,
  onCreateAgent,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
  open,
}: CreateMenuPopoverProps) => {
  const { t } = useTranslation('shell')
  const select = (action: () => void) => {
    onClose()
    action()
  }

  return (
    <Popover
      anchorRef={anchorRef}
      anchorOrigin
      className={panelClassName}
      label={t('create.title')}
      onClose={onClose}
      open={open}
      placement="right"
      role="menu"
    >
      <h2 className="px-1.5 pb-2 pt-1 text-sm font-semibold text-[color:var(--tx)]">{t('create.title')}</h2>
      <button className={actionRowClassName} onClick={() => select(onCreateMessage)} type="button">
        <span className="create-menu-icon create-menu-icon-message" aria-hidden="true">
          <FontAwesomeIcon icon={faPenToSquare} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[color:var(--tx)]">{t('create.message')}</span>
          <span className="block text-xs text-[color:var(--tx3)]">{t('create.messageDescription')}</span>
        </span>
      </button>
      <button className={actionRowClassName} onClick={() => select(onCreateChannel)} type="button">
        <span className="create-menu-icon create-menu-icon-channel" aria-hidden="true">
          <FontAwesomeIcon icon={faHashtag} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[color:var(--tx)]">{t('create.channel')}</span>
          <span className="block text-xs text-[color:var(--tx3)]">{t('create.channelDescription')}</span>
        </span>
      </button>
      <button className={actionRowClassName} onClick={() => select(onCreateProject)} type="button">
        <span className="create-menu-icon create-menu-icon-project" aria-hidden="true">
          <FontAwesomeIcon icon={faFolderPlus} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[color:var(--tx)]">{t('create.project')}</span>
          <span className="block text-xs text-[color:var(--tx3)]">{t('create.projectDescription')}</span>
        </span>
      </button>
      <button className={actionRowClassName} onClick={() => select(onCreateAgent)} type="button">
        <span className="create-menu-icon create-menu-icon-agent" aria-hidden="true">
          <FontAwesomeIcon icon={faRobot} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-[color:var(--tx)]">{t('create.agent')}</span>
          <span className="block text-xs text-[color:var(--tx3)]">{t('create.agentDescription')}</span>
        </span>
      </button>
    </Popover>
  )
}

// The native phone sheet and this desktop/web menu both call the shell's
// creation handlers. The presentation changes by device; the action boundary
// and authorization do not.
export const CreateMenuTrigger = ({
  onCreateAgent,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
}: CreateMenuTriggerProps) => {
  const { t } = useTranslation('shell')
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
        aria-label={t('create.new')}
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
        onCreateAgent={onCreateAgent}
        onCreateChannel={onCreateChannel}
        onCreateMessage={onCreateMessage}
        onCreateProject={onCreateProject}
        open={isOpen}
      />
      <RailTooltip
        anchorRef={buttonRef}
        description={t('create.tooltipDescription')}
        id="create-menu-tooltip"
        open={tooltipOpen}
        title={t('create.new')}
      />
    </>
  )
}
