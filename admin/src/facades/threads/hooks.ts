import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ThreadMessageRecord } from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'

type StreamState = {
  pendingMessages: Array<{
    content: string
    runId: string
  }>
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

export const useThreadStream = (threadId?: string): StreamState => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()
  const [pendingMessages, setPendingMessages] = useState<StreamState['pendingMessages']>([])

  useEffect(() => {
    if (!threadId || !token) {
      setPendingMessages([])
      return
    }

    const controller = new AbortController()
    const decoder = new TextDecoder()
    let buffer = ''

    void fetch(`${baseUrl}/api/threads/${threadId}/stream`, {
      headers: {
        authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok || !response.body) {
          return
        }

        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''

          for (const frame of frames) {
            const trimmed = frame.trim()
            if (!trimmed || trimmed.startsWith(':')) {
              continue
            }

            const event = trimmed
              .split('\n')
              .find((line) => line.startsWith('event: '))
              ?.slice(7)
            const dataLine = trimmed
              .split('\n')
              .find((line) => line.startsWith('data: '))
              ?.slice(6)

            if (!event || !dataLine) {
              continue
            }

            const data = JSON.parse(dataLine) as {
              content?: string
              runId: string
            }

            if (event === 'stream.start') {
              setPendingMessages((current) => [...current, { content: '', runId: data.runId }])
              continue
            }

            if (event === 'stream.delta') {
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
              continue
            }

            if (event === 'stream.done') {
              setPendingMessages((current) =>
                current.filter((message) => message.runId !== data.runId),
              )
              void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
            }
          }
        }
      })
      .catch(() => undefined)

    return () => {
      controller.abort()
    }
  }, [queryClient, threadId, token])

  return useMemo(
    () => ({
      pendingMessages,
    }),
    [pendingMessages],
  )
}
