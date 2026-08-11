import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import type { ChannelRecord, ThreadMessageRecord } from '../../lib/api-client'
import { readSseStream, type SseFrame } from '../../lib/sse'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import {
  classifyStreamResponse,
  runStreamConnectionLoop,
  type StreamAttemptOutcome,
} from './stream-retry'
import {
  appendThinkingEntry,
  reconcileThreadThinking,
  type PendingStreamMessage,
  type RunThinkingLog,
  type ThinkingEntryKind,
  type ThreadThinking,
} from './thinking'

type StreamState = {
  pendingMessages: PendingStreamMessage[]
}

type StreamEventData = {
  agentId?: string
  // Durable `run_thinking_chunks` id on thought-process events, so a bootstrap
  // fetch and the live stream can overlap without duplicating a chunk.
  chunkId?: string
  content?: string
  createdAt?: string
  messageId?: string
  rootMessageId?: string | null
  runId: string
}

const THINKING_EVENT_KINDS: Record<string, ThinkingEntryKind> = {
  'stream.reasoning': 'reasoning',
  'stream.thinking.tool': 'tool',
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

// Replies of one root message within a thread (#233 reply threads).
export const useThreadReplies = (threadId?: string, rootMessageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ThreadMessageRecord[]>({
    queryKey: ['threads', threadId, 'replies', rootMessageId],
    queryFn: () =>
      apiClient.get(`/api/threads/${threadId}/messages?rootMessageId=${rootMessageId}`),
    enabled: Boolean(threadId) && Boolean(rootMessageId),
  })
}

export type ThreadMessageDetail = {
  message: ThreadMessageRecord
  viewerFollowing: boolean
}

// Single message fetch — used to hydrate a thread panel's root on cold
// deep-links and to read the viewer's follow state.
export const useThreadMessage = (threadId?: string, messageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<ThreadMessageDetail>({
    queryKey: ['threads', threadId, 'message', messageId],
    queryFn: () => apiClient.get(`/api/threads/${threadId}/messages/${messageId}`),
    enabled: Boolean(threadId) && Boolean(messageId),
  })
}

export const useSetMessageThreadFollow = (threadId?: string, messageId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (following: boolean) =>
      apiClient.put<{ following: boolean }>(
        `/api/threads/${threadId}/messages/${messageId}/follow`,
        { following },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['threads', threadId, 'message', messageId],
      })
    },
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

// Full durable thought log for one run. The bubble's own state is lossy (and
// starts mid-run for anyone who joined late), so the dialog reads the record.
export const useRunThinkingLog = (
  threadId: string | undefined,
  runId: string | null,
  enabled: boolean,
) => {
  const apiClient = useApiClient()

  return useQuery<RunThinkingLog>({
    queryKey: ['threads', threadId, 'runs', runId, 'thinking'],
    queryFn: () => apiClient.get(`/api/threads/${threadId}/runs/${runId}/thinking`),
    enabled: enabled && Boolean(threadId) && Boolean(runId),
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
    // When each live run announced itself, so a bootstrap response that was
    // already in flight never discards a run that started after it was sent.
    const liveRunStartedAt = new Map<string, number>()
    // Runs whose `stream.done` this session has seen. A bootstrap response
    // captured while such a run was still live must not re-seed it — that is
    // the zombie-bubble race. Run ids are never reused, so this only grows by
    // one entry per finished run in the open channel.
    const finishedRunIds = new Set<string>()

    // `stream.*` is never replayed from the backlog, so a mid-run joiner (or a
    // reconnect that missed events) rebuilds its bubbles over REST instead.
    const bootstrapThinking = async (signal: AbortSignal) => {
      const requestedAt = Date.now()
      try {
        const response = await fetch(`${baseUrl}/api/threads/${threadId}/thinking`, {
          headers: { authorization: `Bearer ${token}` },
          signal,
        })
        if (!response.ok || cancelled) {
          return
        }

        const payload = (await response.json()) as { data?: ThreadThinking }
        if (cancelled) {
          return
        }

        const protectedRunIds = new Set(
          [...liveRunStartedAt.entries()]
            .filter(([, startedAt]) => startedAt >= requestedAt)
            .map(([runId]) => runId),
        )
        setPendingMessages((current) =>
          reconcileThreadThinking(
            current,
            payload.data?.runs ?? [],
            protectedRunIds,
            finishedRunIds,
          ),
        )
      } catch {
        // Best effort: a failed bootstrap only costs a mid-run joiner its bubble.
      }
    }

    const handleFrame = (frame: SseFrame) => {
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
        liveRunStartedAt.set(data.runId, Date.now())
        setPendingMessages((current) =>
          current.some((message) => message.runId === data.runId)
            ? current
            : [
                ...current,
                {
                  agentId: data.agentId ?? '',
                  content: '',
                  // Absent/null anchors the reply at the top level of the
                  // channel; an id anchors it in that message's thread.
                  rootMessageId: data.rootMessageId ?? null,
                  runId: data.runId,
                  thinking: [],
                },
              ],
        )
        return
      }

      const thinkingKind = frame.event ? THINKING_EVENT_KINDS[frame.event] : undefined
      if (thinkingKind) {
        const content = data.content ?? ''
        if (!content) {
          return
        }
        setPendingMessages((current) =>
          current.map((message) => {
            if (message.runId !== data.runId) {
              return message
            }
            const thinking = appendThinkingEntry(message.thinking, {
              content,
              id: data.chunkId,
              kind: thinkingKind,
            })
            return thinking === message.thinking ? message : { ...message, thinking }
          }),
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
                rootMessageId: data.rootMessageId ?? null,
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
        liveRunStartedAt.delete(data.runId)
        finishedRunIds.add(data.runId)
        setPendingMessages((current) =>
          current.filter((message) => message.runId !== data.runId),
        )
        void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
        if (data.rootMessageId) {
          void queryClient.invalidateQueries({
            queryKey: ['threads', threadId, 'replies', data.rootMessageId],
          })
        }
        return
      }

      if (frame.event === 'message.reaction') {
        void queryClient.invalidateQueries({ queryKey: ['threads', threadId, 'messages'] })
      }
    }

    // One connect-and-drain cycle. The loop around it decides whether to try
    // again; only 403/404 end it, so a 401 mid token rotation or a transient
    // 5xx no longer kills this thread's stream for the rest of the mount.
    const connectOnce = async (): Promise<StreamAttemptOutcome> => {
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

        const outcome = classifyStreamResponse(response)
        if (outcome !== 'connected' || !response.body) {
          return outcome
        }

        void bootstrapThinking(controller.signal)
        try {
          await readSseStream(response.body, handleFrame)
        } catch {
          // Dropped mid-stream. The connection itself worked, so this still
          // counts as connected and the next attempt starts at the base delay.
        }
        return 'connected'
      } finally {
        if (activeController === controller) {
          activeController = null
        }
      }
    }

    void runStreamConnectionLoop({
      attempt: connectOnce,
      isCancelled: () => cancelled,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })

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
