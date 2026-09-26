import type { ReactNode } from 'react'

type DesignerAssistantDockProps = {
  children: ReactNode
  onOpen: () => void
  open: boolean
}

/**
 * One full-height dock beside every tab of the agent page (below them on a
 * narrow screen), holding the Design Assistant's conversation. The page owns
 * the conversation, so moving between tabs — or closing the dock and opening
 * it again — never loses it.
 */
export const DesignerAssistantDock = ({ children, onOpen, open }: DesignerAssistantDockProps) => (
  <>
    {!open ? (
      <button
        aria-controls="agent-designer-assistant-drawer"
        aria-expanded="false"
        className="admin-button admin-button-secondary m-3 self-start"
        onClick={onOpen}
        type="button"
      >
        Open Design Assistant
      </button>
    ) : null}
    <aside
      aria-hidden={!open}
      aria-label="Design Assistant"
      className={[
        'w-full overflow-hidden border-t border-[color:var(--sep)] bg-[color:var(--sb)]',
        'transition-[width,height,opacity] duration-300 ease-out',
        'lg:h-full lg:border-t-0 lg:border-l',
        open
          ? 'h-[360px] min-h-[320px] opacity-100 lg:w-[min(380px,32vw)] lg:min-w-[320px]'
          : 'h-0 min-h-0 border-t-0 opacity-0 lg:w-0 lg:min-w-0 lg:border-l-0',
      ].join(' ')}
      id="agent-designer-assistant-drawer"
    >
      {/* Kept mounted while closed, so a half-typed message survives. */}
      <div className="h-full w-full lg:w-[min(380px,32vw)] lg:min-w-[320px]" inert={!open}>
        {children}
      </div>
    </aside>
  </>
)
