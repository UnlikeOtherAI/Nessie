import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type DesignerPageContext = {
  actions: string[]
  description: string
  title: string
}

export type DesignerAssistantActionHandler = (
  name: string,
  args: Record<string, unknown>,
) => boolean

type DesignerAssistantPanelState = {
  actionHandler: DesignerAssistantActionHandler
  closeDrawer: () => void
  pageContext: DesignerPageContext
  panelOutlet: HTMLDivElement | null
  registerActionHandler: (handler: DesignerAssistantActionHandler | null) => void
  registerDrawerClose: (close: (() => void) | null) => void
  setPageContext: (context: DesignerPageContext) => void
  setPanelOutlet: (outlet: HTMLDivElement | null) => void
}

const defaultPageContext: DesignerPageContext = {
  actions: [],
  description: 'Review this agent and its available team controls.',
  title: 'Agent',
}

const DesignerAssistantPanelContext = createContext<DesignerAssistantPanelState | null>(null)

export const DesignerAssistantPanelProvider = ({ children }: { children: ReactNode }) => {
  const [pageContext, setPageContext] = useState(defaultPageContext)
  const [panelOutlet, setPanelOutlet] = useState<HTMLDivElement | null>(null)
  const actionHandlerRef = useRef<DesignerAssistantActionHandler | null>(null)
  const drawerCloseRef = useRef<(() => void) | null>(null)

  const registerActionHandler = useCallback((handler: DesignerAssistantActionHandler | null) => {
    actionHandlerRef.current = handler
  }, [])

  const actionHandler: DesignerAssistantActionHandler = useCallback((name, args) =>
    actionHandlerRef.current?.(name, args) ?? false, [])
  const closeDrawer = useCallback(() => drawerCloseRef.current?.(), [])
  const registerDrawerClose = useCallback((close: (() => void) | null) => {
    drawerCloseRef.current = close
  }, [])

  return (
    <DesignerAssistantPanelContext.Provider
      value={{
        actionHandler,
        closeDrawer,
        pageContext,
        panelOutlet,
        registerActionHandler,
        registerDrawerClose,
        setPageContext,
        setPanelOutlet,
      }}
    >
      {children}
    </DesignerAssistantPanelContext.Provider>
  )
}

export const useDesignerAssistantPanel = () => useContext(DesignerAssistantPanelContext)
