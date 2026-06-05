import type { Dispatch, SetStateAction } from 'react'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  dividerClass,
  menuItemClass,
  sectionLabelClass,
  toolbarButtonClass,
} from '../../../lib/workflow-designer/constants'
import type { ToolbarAction, ToolbarMenuItem } from '../../../lib/workflow-designer/types'

type WorkflowToolbarProps = {
  toolbarActions: ToolbarAction[]
  openMenu: string | null
  setOpenMenu: Dispatch<SetStateAction<string | null>>
  onMenuItemClick: (item: ToolbarMenuItem) => void
}

export const WorkflowToolbar = ({
  toolbarActions,
  openMenu,
  setOpenMenu,
  onMenuItemClick,
}: WorkflowToolbarProps) => {
  return (
    <header className="flex h-12 items-center gap-2 border-b border-black/8 bg-[#faf8fc] px-4">
      {toolbarActions.map((action) => {
        const isOpen = openMenu === action.key

        return (
          <div
            key={action.key}
            className="relative"
            data-workflow-menu-root="true"
          >
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
                className="absolute left-0 top-full z-10 mt-1 w-64 rounded-lg border border-black/10 bg-white p-1 shadow-[0_12px_30px_rgba(31,22,38,0.14)]"
                role="menu"
              >
                {action.createItem ? (
                  <button
                    className={menuItemClass}
                    onClick={() => onMenuItemClick(action.createItem!)}
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
                        onClick={() => onMenuItemClick(item)}
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
  )
}
