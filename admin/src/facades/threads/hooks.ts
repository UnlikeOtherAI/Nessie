import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelRecord, ThreadMessageRecord } from '../../lib/api-client'
import { readSseStream } from '../../lib/sse'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

type StreamState = {
  pendingMessages: Array<{
    agentId: string
    content: string
    reasoningContent: string
    runId: string
  }>
}

type StreamEventData = {
  agentId?: string
  content?: string
  createdAt?: string
  messageId?: string
  runId: string
}

const baseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ?? ''

export const useThreadMessages = (threadId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ThreadMessageRecord[]>({
    queryKey: ['threads', threadId, 'messages'],
    queryFn: () => apiClient.get(`/api/threads/${threadId}/messages`),
    enabled: Boolean(threadId),
  })
}

export const useMarkThreadRead = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (threadId: string) => apiClient.post(`/api/threads/${threadId}/read`, {}),
    onMutate: (threadId) => {
      queryClient.setQueryData<ChannelRecord[] | undefined>(
        ['channels'],
        (current) =>
          current?.map((channel) =>
            channel.defaultThreadId === threadId
              ? { ...channel, unreadCount: 0 }
              : channel,
          ),
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ['channels'] })
    },
  })
}

export const useThreadStream = (threadId?: string): StreamState => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  const [pendingMessages, setPendingMessages] = useState<StreamState['pendingMessages']>([])

  useEffect(() => {
    // Always reset on threadId/token change: without this, pending stream
    // entries from a previous channel leak into the next one when the user
    // navigates mid-replay.
    setPendingMessages([])

    if (!threadId || !token) {
      return
    }

    let cancelled = false
    let lastEventId = ''
    let activeController: AbortController | null = null

    const connectStream = async () => {
      while (!cancelled) {
        const controller = new AbortController()
        activeController = controller

        try {
          const headers: Record<string, string> = {
            authorization: `Bearer ${token}`,
          }
          // Resume from last known event ID on reconnect
          if (lastEventId) {
            headers['Last-Event-ID'] = lastEventId
          }

          const response = await fetch(`${baseUrl}/api/threads/${threadId}/stream`, {
            headers,
            signal: controller.signal,
          })

          if (!response.ok || !response.body) {
            break
          }

          await readSseStream(response.body, (frame) => {
            if (cancelled) {
              return
            }

            // Track Last-Event-ID for reconnection
            if (frame.id) {
              lastEventId = frame.id
            }

            if (!frame.event || !frame.data) {
              return
            }

            const data = JSON.parse(frame.data) as StreamEventData

            if (frame.event === 'stream.start') {
              setPendingMessages((current) =>
                current.some((message) => message.runId === data.runId)
                  ? current
                  : [
                      ...current,
                      {
                        agentId: data.agentId ?? '',
                        content: '',
                        reasoningContent: '',
                        runId: data.runId,
                      },
                    ],
              )
              return
            }

            if (frame.event === 'stream.reasoning') {
              setPendingMessages((current) =>
                current.map((message) =>
                  message.runId === data.runId
                    ? {
                        ...message,
                        reasoningContent: `${message.reasoningContent}${data.content ?? ''}`,
                      }
                    : message,
                ),
              )
              return
            }

            if (frame.event === 'stream.delta') {
              setPendingMessages((current) =>
                current.map((message) =>
                  message.runId === data.runId
                    ? {
                        ...message,
                        content: `${message.content}${data.content ?? ''}`,
                      }
                    : message,
                ),
              )
              return
            }

            if (frame.event === 'stream.done') {
              if (data.messageId && data.content !== undefined) {
                queryClient.setQueryData<ThreadMessageRecord[] | undefined>(
                  ['threads', threadId, 'messages'],
                  (current) => {
                    const finalMessage: ThreadMessageRecord = {
                      agentId: data.agentId ?? null,
                      content: data.content ?? '',
                      createdAt: data.createdAt ?? new Date().toISOString(),
                      id: data.messageId ?? '',
                      reactions: [],
                      role: 'assistant',
                      threadId,
                    }
                    const messages = current ?? []
                    return [
                      ...messages.filter((message) => message.id !== finalMessage.id),
                      finalMessage,
                    ]
                  },
                )
              }
              setPendingMessages((current) =>
                current.filter((message) => message.runId !== data.runId),
              )
              void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
              return
            }

            if (frame.event === 'message.reaction') {
              void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
            }
          })
        } catch {
          // Connection lost — will reconnect
        } finally {
          if (activeController === controller) {
            activeController = null
          }
        }

        // Reconnect after 2 seconds unless cancelled
        if (!cancelled) {
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
    }

    void connectStream()

    return () => {
      cancelled = true
      activeController?.abort()
    }
  }, [queryClient, threadId, token])

  return useMemo(
    () => ({
      pendingMessages,
    }),
    [pendingMessages],
  )
}
