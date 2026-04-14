import { useEffect, useRef, useState } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faBolt,
  faChevronDown,
  faList,
  faPlus,
  faRobot,
  faScrewdriverWrench,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate } from 'react-router-dom'

type ToolbarMenuItem = {
  icon: IconDefinition
  key: string
  label: string
  to: string
}

type ToolbarAction = {
  icon: IconDefinition
  items: ToolbarMenuItem[]
  key: string
  label: string
}

const toolbarActions: ToolbarAction[] = [
  {
    icon: faBolt,
    key: 'trigger',
    label: 'Trigger',
    items: [
      {
        icon: faPlus,
        key: 'new-trigger',
        label: 'New trigger',
        to: '/agents/triggers',
      },
      {
        icon: faList,
        key: 'all-triggers',
        label: 'All triggers',
        to: '/agents/triggers',
      },
    ],
  },
  {
    icon: faScrewdriverWrench,
    key: 'tools',
    label: 'Tools',
    items: [
      {
        icon: faPlus,
        key: 'new-tool',
        label: 'New tool',
        to: '/settings#tools',
      },
      {
        icon: faList,
        key: 'all-tools',
        label: 'All tools',
        to: '/settings#tools',
      },
    ],
  },
  {
    icon: faRobot,
    key: 'agents',
    label: 'Agents',
    items: [
      {
        icon: faPlus,
        key: 'new-agent',
        label: 'New agent',
        to: '/agents/designer',
      },
      {
        icon: faList,
        key: 'all-agents',
        label: 'All agents',
        to: '/agents',
      },
    ],
  },
]

const toolbarButtonClass = [
  'inline-flex h-9 items-center gap-2 rounded-md border border-black/10',
  'bg-white px-3 text-sm font-medium text-[#433349] transition-colors',
  'hover:bg-[#f4eff8]',
].join(' ')

const menuItemClass = [
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
  'text-[#433349] transition-colors hover:bg-[#f4eff8]',
].join(' ')

export const WorkflowDesignerPage = () => {
  const navigate = useNavigate()
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!pageRef.current?.contains(event.target as Node)) {
        setOpenMenu(null)
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('mousedown', handlePointerDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [])

  const handleMenuItemClick = (to: string) => {
    setOpenMenu(null)
    void navigate(to)
  }

  return (
    <div
      ref={pageRef}
      aria-label="Workflow Designer"
      className="flex h-full w-full flex-col bg-white"
    >
      <header className="flex h-14 items-center gap-2 border-b border-black/8 bg-[#faf8fc] px-4">
        {toolbarActions.map((action) => {
          const isOpen = openMenu === action.key

          return (
            <div key={action.key} className="relative">
              <button
                aria-expanded={isOpen}
                aria-haspopup="menu"
                aria-label={action.label}
                className={toolbarButtonClass}
                onClick={() => setOpenMenu(isOpen ? null : action.key)}
                type="button"
              >
                <FontAwesomeIcon className="text-sm" fixedWidth icon={action.icon} />
                <span>{action.label}</span>
                <FontAwesomeIcon
                  className={[
                    'text-[11px] text-[#6f5b77] transition-transform',
                    isOpen ? 'rotate-180' : '',
                  ].join(' ')}
                  fixedWidth
                  icon={faChevronDown}
                />
              </button>

              {isOpen ? (
                <div
                  className="absolute left-0 top-full z-10 mt-2 w-48 rounded-lg border border-black/10 bg-white p-1 shadow-[0_12px_30px_rgba(31,22,38,0.14)]"
                  role="menu"
                >
                  {action.items.map((item) => (
                    <button
                      key={item.key}
                      className={menuItemClass}
                      onClick={() => handleMenuItemClick(item.to)}
                      role="menuitem"
                      type="button"
                    >
                      <FontAwesomeIcon className="text-[13px]" fixedWidth icon={item.icon} />
                      <span>{item.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </header>

      <div className="flex-1 bg-white" />
    </div>
  )
}
