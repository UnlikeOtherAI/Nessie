import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'

export type DesignerAssistantActionHandler = (
  name: string,
  args: Record<string, unknown>,
) => boolean

type DesignerAssistantPanelState = {
  /**
   * Hands a tool call to the control that owns it. When that control is not
   * mounted yet — the page is still switching to its tab — the call waits and
   * is replayed the moment the control registers, instead of being lost.
   */
  dispatchToolCall: (name: string, args: Record<string, unknown>) => boolean
  registerActionHandler: (handler: DesignerAssistantActionHandler | null) => void
}

const DesignerAssistantPanelContext = createContext<DesignerAssistantPanelState | null>(null)

/**
 * The agent page's line between the Design Assistant and a control that keeps
 * its own state. Today that is one control: an existing agent's tools, which
 * the Access tab edits and saves itself (`AgentAvailableTools`), so the
 * assistant's toggles go to it rather than into the form.
 */
export const DesignerAssistantPanelProvider = ({ children }: { children: ReactNode }) => {
  const handlerRef = useRef<DesignerAssistantActionHandler | null>(null)
  const pendingRef = useRef<Array<{ args: Record<string, unknown>; name: string }>>([])

  const registerActionHandler = useCallback((handler: DesignerAssistantActionHandler | null) => {
    handlerRef.current = handler
    if (!handler) return
    const pending = pendingRef.current
    pendingRef.current = []
    for (const call of pending) handler(call.name, call.args)
  }, [])

  const dispatchToolCall = useCallback((name: string, args: Record<string, unknown>) => {
    const handler = handlerRef.current
    if (handler) return handler(name, args)
    pendingRef.current.push({ args, name })
    return true
  }, [])

  const value = useMemo(
    () => ({ dispatchToolCall, registerActionHandler }),
    [dispatchToolCall, registerActionHandler],
  )

  return (
    <DesignerAssistantPanelContext.Provider value={value}>
      {children}
    </DesignerAssistantPanelContext.Provider>
  )
}

export const useDesignerAssistantPanel = () => useContext(DesignerAssistantPanelContext)
