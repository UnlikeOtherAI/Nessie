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
  status: string | null
  streaming: boolean
  thinking: boolean
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

type ActiveToolCall = {
  argsBuffer: string
  lastContentLen: number
  name: string
}

/**
 * Extract the "content" value from a partially-streamed JSON args string
 * like `{"content":"Hello wor`. Returns null if the key hasn't appeared yet.
 */
const extractPartialContent = (buf: string): string | null => {
  const marker = buf.indexOf('"content"')
  if (marker === -1) return null

  // Find the colon after "content", then the opening quote
  const colonIdx = buf.indexOf(':', marker + 9)
  if (colonIdx === -1) return null
  const quoteIdx = buf.indexOf('"', colonIdx + 1)
  if (quoteIdx === -1) return null

  // Everything after the opening quote is partial content
  let raw = buf.slice(quoteIdx + 1)

  // Strip trailing "} if the JSON object closed
  if (raw.endsWith('"}')) raw = raw.slice(0, -2)
  else if (raw.endsWith('"')) raw = raw.slice(0, -1)

  // Unescape JSON string escapes
  try {
    return JSON.parse('"' + raw + '"') as string
  } catch {
    // Incomplete escape at tail — parse everything except last char
    if (raw.length > 0 && raw.endsWith('\\')) {
      try {
        return JSON.parse('"' + raw.slice(0, -1) + '"') as string
      } catch { /* fall through */ }
    }
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
}

const scrollSystemPromptToBottom = (): void => {
  const el = document.getElementById('agent-system-prompt')
  if (el) el.scrollTop = el.scrollHeight
}

export const useDesignerChat = (
  formState: AgentFormState,
  actions: AgentDesignerActions,
) => {
  const { token } = useAuthSession()
  const [state, setState] = useState<DesignerChatState>({
    error: null,
    messages: [],
    status: null,
    streaming: false,
    thinking: false,
  })
  const abortRef = useRef<AbortController | null>(null)
  const activeToolCallsRef = useRef(
    new Map<string, ActiveToolCall>(),
  )

  const send = useCallback(
    async (userMessage: string) => {
      if (!userMessage.trim() || state.streaming) return

      const userMsg: ChatMessage = { role: 'user', content: userMessage.trim() }
      const allMessages = [...state.messages, userMsg]

      setState((prev) => ({
        ...prev,
        error: null,
        messages: [
          ...prev.messages,
          userMsg,
          { role: 'assistant', content: '' },
        ],
        status: null,
        streaming: true,
        thinking: true,
      }))

      activeToolCallsRef.current.clear()
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
            messages: allMessages.filter((m) => m.content.trim() !== ''),
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
                processEvent(
                  currentEvent,
                  data,
                  setState,
                  actions,
                  activeToolCallsRef.current,
                )
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
          status: null,
          streaming: false,
          thinking: false,
        }))
      } finally {
        actions.dispatch({ type: 'clear_streaming', field: '' })
        activeToolCallsRef.current.clear()
        setState((prev) => ({
          ...prev,
          status: null,
          streaming: false,
          thinking: false,
        }))
        abortRef.current = null
      }
    },
    [state.messages, state.streaming, formState, actions, token],
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    activeToolCallsRef.current.clear()
    setState((prev) => ({
      ...prev,
      status: null,
      streaming: false,
      thinking: false,
    }))
    actions.dispatch({ type: 'clear_streaming', field: '' })
  }, [actions])

  return { ...state, send, stop }
}

const processEvent = (
  event: string,
  data: Record<string, unknown>,
  setState: React.Dispatch<React.SetStateAction<DesignerChatState>>,
  actions: AgentDesignerActions,
  activeToolCalls: Map<string, ActiveToolCall>,
): void => {
  switch (event) {
    case 'reasoning.delta': {
      // Model is thinking — keep thinking state on (already set at stream start)
      setState((prev) => (prev.thinking ? prev : { ...prev, thinking: true }))
      break
    }

    case 'text.delta': {
      const content = String(data.content ?? '')
      setState((prev) => {
        const msgs = [...prev.messages]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = {
            ...last,
            content: last.content + content,
          }
        }
        return { ...prev, messages: msgs, status: null, thinking: false }
      })
      break
    }

    case 'status': {
      const message = String(data.message ?? '')
      setState((prev) => ({
        ...prev,
        status: message,
        thinking: true,
      }))
      break
    }

    case 'tool_call.start': {
      const name = String(data.name ?? '')
      const id = String(data.id ?? '')
      const field = TOOL_TO_FIELD[name]
      if (field) {
        actions.dispatch({ type: 'set_streaming', field })
      }
      // For set_system_prompt, clear the field so tokens stream in fresh
      if (name === 'set_system_prompt') {
        actions.dispatch({ type: 'set_system_prompt', prompt: '' })
      }
      activeToolCalls.set(id, { argsBuffer: '', lastContentLen: 0, name })
      // Show status for known tool actions
      const statusMap: Record<string, string> = {
        set_system_prompt: 'Writing system prompt...',
        web_search: 'Searching the web...',
      }
      const status = statusMap[name] ?? null
      setState((prev) => ({
        ...prev,
        thinking: false,
        status: status ?? prev.status,
      }))
      break
    }

    case 'tool_call.delta': {
      const id = String(data.id ?? '')
      const argChunk = String(data.args ?? '')
      const tc = activeToolCalls.get(id)
      if (!tc) break

      tc.argsBuffer += argChunk

      // Stream content tokens into system prompt textarea
      if (tc.name === 'set_system_prompt') {
        const fullContent = extractPartialContent(tc.argsBuffer)
        if (fullContent !== null && fullContent.length > tc.lastContentLen) {
          const newChunk = fullContent.slice(tc.lastContentLen)
          tc.lastContentLen = fullContent.length
          actions.dispatch({ type: 'append_system_prompt', chunk: newChunk })
          scrollSystemPromptToBottom()
        }
      }
      break
    }

    case 'tool_call.done': {
      const name = String(data.name ?? '')
      const id = String(data.id ?? '')
      const args = data.args as Record<string, unknown> | undefined
      if (args) {
        // For system prompt, skip the full set — we already streamed it in
        if (name !== 'set_system_prompt') {
          actions.applyToolCall(name, args)
        } else {
          // Final safety set in case streaming missed chars
          const content = String(args.content ?? '')
          actions.dispatch({ type: 'set_system_prompt', prompt: content })
        }
      }
      const field = TOOL_TO_FIELD[name]
      if (field) {
        actions.dispatch({ type: 'clear_streaming', field })
      }
      activeToolCalls.delete(id)
      break
    }

    case 'error': {
      const message = String(data.message ?? 'Unknown error')
      setState((prev) => ({
        ...prev,
        error: message,
        status: null,
        thinking: false,
      }))
      break
    }
  }
}
