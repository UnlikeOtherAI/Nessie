import { useCallback, useRef, useState } from 'react'
import type {
  AgentDesignerActions,
  AgentFormState,
} from '../../components/features/agents/designer/useAgentDesigner'
import { getBaseUrl } from '../../lib/api-client'
import { useAuthSession } from '../../providers/AuthSessionProvider'

export type ChatMessage = {
  content: string
  role: 'assistant' | 'user'
}

type DesignerChatState = {
  error: string | null
  messages: ChatMessage[]
  streaming: boolean
}

// Maps tool call names to the streaming field they affect
const TOOL_TO_FIELD: Record<string, string> = {
  set_name: 'name',
  set_role: 'role',
  set_system_prompt: 'systemPrompt',
  set_category: 'categoryId',
  set_provider: 'provider',
  set_model: 'model',
}

export const useDesignerChat = (
  formState: AgentFormState,
  actions: AgentDesignerActions,
) => {
  const { token } = useAuthSession()
  const [state, setState] = useState<DesignerChatState>({
    error: null,
    messages: [],
    streaming: false,
  })
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (userMessage: string) => {
      if (!userMessage.trim() || state.streaming) return

      const userMsg: ChatMessage = { role: 'user', content: userMessage.trim() }
      const allMessages = [...state.messages, userMsg]

      setState((prev) => ({
        ...prev,
        error: null,
        messages: [...prev.messages, userMsg, { role: 'assistant', content: '' }],
        streaming: true,
      }))

      const controller = new AbortController()
      abortRef.current = controller

      try {
        const baseUrl = getBaseUrl()
        const response = await fetch(`${baseUrl}/api/designer/chat`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messages: allMessages,
            formState: {
              name: formState.name,
              role: formState.role,
              systemPrompt: formState.systemPrompt,
              categoryId: formState.categoryId,
              provider: formState.provider,
              model: formState.model,
              tools: formState.tools,
            },
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const text = await response.text()
          throw new Error(`Server error ${response.status}: ${text}`)
        }

        if (!response.body) {
          throw new Error('No response body')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let currentEvent = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              const raw = line.slice(6).trim()
              try {
                const data = JSON.parse(raw) as Record<string, unknown>
                processEvent(currentEvent, data, setState, actions)
              } catch {
                // ignore malformed data
              }
            }
            // blank line resets current event
            if (line === '') {
              currentEvent = ''
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setState((prev) => ({
          ...prev,
          error: (err as Error).message,
          streaming: false,
        }))
      } finally {
        actions.dispatch({ type: 'clear_streaming', field: '' })
        setState((prev) => ({ ...prev, streaming: false }))
        abortRef.current = null
      }
    },
    [state.messages, state.streaming, formState, actions, token],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setState((prev) => ({ ...prev, streaming: false }))
    actions.dispatch({ type: 'clear_streaming', field: '' })
  }, [actions])

  return { ...state, send, stop }
}

const processEvent = (
  event: string,
  data: Record<string, unknown>,
  setState: React.Dispatch<React.SetStateAction<DesignerChatState>>,
  actions: AgentDesignerActions,
): void => {
  switch (event) {
    case 'text.delta': {
      const content = String(data.content ?? '')
      setState((prev) => {
        const msgs = [...prev.messages]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: last.content + content }
        }
        return { ...prev, messages: msgs }
      })
      break
    }

    case 'tool_call.start': {
      const name = String(data.name ?? '')
      const field = TOOL_TO_FIELD[name]
      if (field) {
        actions.dispatch({ type: 'set_streaming', field })
      }
      break
    }

    case 'tool_call.done': {
      const name = String(data.name ?? '')
      const args = data.args as Record<string, unknown> | undefined
      if (args) {
        actions.applyToolCall(name, args)
      }
      const field = TOOL_TO_FIELD[name]
      if (field) {
        actions.dispatch({ type: 'clear_streaming', field })
      }
      break
    }

    case 'error': {
      const message = String(data.message ?? 'Unknown error')
      setState((prev) => ({ ...prev, error: message }))
      break
    }
  }
}
