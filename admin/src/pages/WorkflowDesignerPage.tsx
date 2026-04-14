import { useEffect, useMemo, useRef, useState } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faBolt,
  faChevronDown,
  faPlus,
  faRobot,
  faScrewdriverWrench,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAgents } from '../facades/agents/hooks'
import { useTriggers } from '../facades/triggers/hooks'
import { useTools } from '../facades/tools/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'

type ToolbarMenuItem = {
  icon: IconDefinition
  key: string
  label: string
  meta?: string
  state?: { returnTo: string }
  to: string
}

type ToolbarAction = {
  createItem?: ToolbarMenuItem
  emptyLabel: string
  icon: IconDefinition
  items: ToolbarMenuItem[]
  key: string
  label: string
  sectionLabel: string
}

const toolbarButtonClass = [
  'inline-flex h-8 items-center gap-1.5 rounded-md border border-black/10',
  'bg-white px-2.5 text-[11px] font-medium text-[#433349] transition-colors',
  'hover:bg-[#f4eff8]',
].join(' ')

const menuItemClass = [
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
  'text-[#433349] transition-colors hover:bg-[#f4eff8]',
].join(' ')

const sectionLabelClass =
  'px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b7a93]'

const dividerClass = 'my-1 border-t border-black/8'

const normalizeReturnTo = (pathname: string, search: string, hash: string) =>
  `${pathname}${search}${hash}`

export const WorkflowDesignerPage = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { me } = useAuthSession()
  const { data: agents = [] } = useAgents()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: tools = [] } = useTools()

  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)

  const returnTo = normalizeReturnTo(
    location.pathname,
    location.search,
    location.hash,
  )

  const toolbarActions = useMemo<ToolbarAction[]>(() => {
    const topLevelAgents = [...agents]
      .filter((agent) => !agent.parentAgentId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((agent) => ({
        icon: faRobot,
        key: agent.id,
        label: agent.name,
        meta: agent.role,
        state: { returnTo },
        to: `/agents/designer/${agent.id}`,
      }))

    const allTriggers = [...triggers]
      .sort((left, right) =>
        (left.name ?? left.type).localeCompare(right.name ?? right.type),
      )
      .map((trigger) => ({
        icon: faBolt,
        key: trigger.id,
        label: trigger.name ?? trigger.type,
        meta: trigger.type,
        to: `/agents/triggers#trigger-${trigger.id}`,
      }))

    const allTools = [...tools]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((tool) => ({
        icon: faScrewdriverWrench,
        key: tool.id,
        label: tool.label,
        meta: tool.safe ? 'safe' : 'restricted',
        to: `/settings#tool-${tool.id}`,
      }))

    return [
      {
        createItem: {
          icon: faPlus,
          key: 'new-trigger',
          label: 'New trigger',
          to: '/agents/triggers',
        },
        emptyLabel: 'No triggers yet',
        icon: faBolt,
        items: allTriggers,
        key: 'trigger',
        label: 'Trigger',
        sectionLabel: 'All triggers',
      },
      {
        createItem: {
          icon: faPlus,
          key: 'new-tool',
          label: 'New tool',
          to: '/settings#tools',
        },
        emptyLabel: 'No tools yet',
        icon: faScrewdriverWrench,
        items: allTools,
        key: 'tools',
        label: 'Tools',
        sectionLabel: 'All tools',
      },
      {
        createItem: {
          icon: faPlus,
          key: 'new-agent',
          label: 'New agent',
          state: { returnTo },
          to: '/agents/designer',
        },
        emptyLabel: 'No top-level agents',
        icon: faRobot,
        items: topLevelAgents,
        key: 'agents',
        label: 'Agents',
        sectionLabel: 'Top-level agents',
      },
    ]
  }, [agents, returnTo, tools, triggers])

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

  const handleMenuItemClick = (item: ToolbarMenuItem) => {
    setOpenMenu(null)
    void navigate(item.to, item.state ? { state: item.state } : undefined)
  }

  return (
    <div
      ref={pageRef}
      aria-label="Workflow Designer"
      className="flex h-full w-full flex-col bg-white"
    >
      <header className="flex h-12 items-center gap-2 border-b border-black/8 bg-[#faf8fc] px-4">
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
                <FontAwesomeIcon className="text-[11px]" fixedWidth icon={action.icon} />
                <span>{action.label}</span>
                <FontAwesomeIcon
                  className={[
                    'text-[10px] text-[#6f5b77] transition-transform',
                    isOpen ? 'rotate-180' : '',
                  ].join(' ')}
                  fixedWidth
                  icon={faChevronDown}
                />
              </button>

              {isOpen ? (
                <div
                  className="absolute left-0 top-full z-10 mt-2 w-64 rounded-lg border border-black/10 bg-white p-1 shadow-[0_12px_30px_rgba(31,22,38,0.14)]"
                  role="menu"
                >
                  {action.createItem ? (
                    <button
                      className={menuItemClass}
                      onClick={() => handleMenuItemClick(action.createItem!)}
                      role="menuitem"
                      type="button"
                    >
                      <FontAwesomeIcon
                        className="text-[12px]"
                        fixedWidth
                        icon={action.createItem.icon}
                      />
                      <span className="truncate text-[11px]">
                        {action.createItem.label}
                      </span>
                    </button>
                  ) : null}

                  {action.createItem ? <div className={dividerClass} /> : null}

                  <div className={sectionLabelClass}>{action.sectionLabel}</div>

                  <div className="max-h-72 overflow-y-auto">
                    {action.items.length > 0 ? (
                      action.items.map((item) => (
                        <button
                          key={item.key}
                          className={menuItemClass}
                          onClick={() => handleMenuItemClick(item)}
                          role="menuitem"
                          type="button"
                        >
                          <FontAwesomeIcon
                            className="text-[12px]"
                            fixedWidth
                            icon={item.icon}
                          />
                          <span className="min-w-0 flex-1 truncate text-[11px]">
                            {item.label}
                          </span>
                          {item.meta ? (
                            <span className="truncate text-[10px] text-[#8b7a93]">
                              {item.meta}
                            </span>
                          ) : null}
                        </button>
                      ))
                    ) : (
                      <div className="px-2.5 py-2 text-[11px] text-[#8b7a93]">
                        {action.emptyLabel}
                      </div>
                    )}
                  </div>
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
