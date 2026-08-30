import { useEffect, useState } from 'react'
import { useDesignerAssistantPanel } from './DesignerAssistantPanelContext'

/**
 * A single, full-height drawer for every agent-detail tab. The chat itself is
 * portalled into this outlet by the edit surface, keeping one conversation as
 * the person moves around the designer.
 */
export const DesignerAssistantDrawer = () => {
  const panel = useDesignerAssistantPanel()
  const [open, setOpen] = useState(true)

  useEffect(() => {
    panel?.registerDrawerClose(() => setOpen(false))
    return () => panel?.registerDrawerClose(null)
  }, [panel])

  if (!panel) return null

  return (
    <>
      {!open ? (
        <button
          aria-controls="agent-designer-assistant-drawer"
          aria-expanded="false"
          className="admin-button admin-button-secondary m-3 self-start"
          onClick={() => setOpen(true)}
          type="button"
        >
          Open Design Assistant
        </button>
      ) : null}
      <aside
        aria-label="Design Assistant"
        aria-hidden={!open}
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
        <div className="h-full w-full lg:w-[min(380px,32vw)] lg:min-w-[320px]" ref={panel.setPanelOutlet} />
      </aside>
    </>
  )
}
