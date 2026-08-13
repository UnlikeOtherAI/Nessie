import type { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  createPartialJsonScanner,
  parseAgentId,
  parseRunId,
  parseThreadId,
  type DocumentStreamErrorReason,
  type PartialJsonScanner,
} from '@nessie/schemas'
import { KB_DOCUMENT_COMPOSE_TOOL_ID } from '@nessie/runtime'
import { createDurableLane, createLiveLane } from './document-stream-lanes.js'

/** The argument whose value is the document body. */
const MARKDOWN_ARGUMENT = 'markdown'

type RunContext = {
  agentId: string
  id: string
  organizationId: string
  threadId: string
}

export type DocumentSessionHandle = {
  markdown: string
  parentPageId: string | null
  sessionId: string
  spaceId: string | null
  title: string | null
}

export type DocumentStreamRecorder = {
  /**
   * Start of one inference attempt. Tool-call indexes restart here, and any
   * session still streaming belonged to an attempt that is being replaced.
   */
  beginInvocation: (invocationId: string) => void
  /** Synchronous by contract — never awaits the database. */
  handleToolCallDelta: (event: {
    id: string
    index: number
    invocationId: string
    text: string
    toolName: string
  }) => void
  /** Awaits session creation plus both lanes for one tool call. */
  settle: (toolCallId: string) => Promise<DocumentSessionHandle | null>
  /** Terminalize every session that never reached a terminal state. */
  finalizeOutstanding: (reason: DocumentStreamErrorReason) => Promise<void>
  /**
   * Whether a document is composing right now. Cheap and in-memory, so a
   * cancellation poller can gate its database reads on it instead of polling
   * every run unconditionally.
   */
  hasOpenSession: () => boolean
  close: () => Promise<void>
}

type TrackedCall = {
  created: Promise<void> | null
  durable: ReturnType<typeof createDurableLane> | null
  live: ReturnType<typeof createLiveLane> | null
  metaPublished: boolean
  publishedLength: number
  scanner: PartialJsonScanner
  sessionId: string | null
  terminal: boolean
  toolCallId: string
}

type RecorderInput = {
  prisma: PrismaClient
  realtimeTransport: Pick<PgRealtimeTransport, 'publishSse' | 'publishSseEphemeral'>
  run: RunContext
}

/**
 * Turns a model's in-flight `kb_document_compose` arguments into a live
 * document stream.
 *
 * Everything here is presentation: authorization still happens when the tool
 * actually executes. Failures are swallowed — a broken preview must never fail
 * a run that is otherwise writing a perfectly good document.
 */
export const createDocumentStreamRecorder = (
  input: RecorderInput,
): DocumentStreamRecorder => {
  const byIndex = new Map<number, TrackedCall>()
  const byToolCallId = new Map<string, TrackedCall>()
  let invocationId: string | null = null
  let closed = false

  const publish = async (
    event: 'stream.document.start' | 'stream.document.meta'
      | 'stream.document.done' | 'stream.document.error',
    data: Parameters<PgRealtimeTransport['publishSse']>[2],
  ): Promise<void> => {
    try {
      await input.realtimeTransport.publishSse(input.run.threadId, event, data)
    } catch (error) {
      console.warn('[worker] document stream publish failed', event, error)
    }
  }

  const terminalize = async (
    call: TrackedCall,
    reason: DocumentStreamErrorReason,
  ): Promise<void> => {
    if (call.terminal || !call.sessionId) return
    call.terminal = true
    const sessionId = call.sessionId
    try {
      const updated = await input.prisma.runDocumentSession.updateMany({
        data: {
          errorReason: reason,
          finishedAt: new Date(),
          status: reason === 'cancelled' ? 'cancelled' : 'failed',
        },
        // Only a session that is still open: a saved one has already won.
        where: { id: sessionId, status: { in: ['streaming', 'saving'] } },
      })
      if (updated.count === 0) return
    } catch (error) {
      console.warn('[worker] document stream terminalize failed', error)
      return
    }
    await publish('stream.document.error', {
      reason,
      runId: parseRunId(input.run.id),
      sessionId,
    })
  }

  const createSession = async (call: TrackedCall, currentInvocation: string): Promise<void> => {
    try {
      const session = await input.prisma.runDocumentSession.create({
        data: {
          agentId: input.run.agentId,
          invocationId: currentInvocation,
          organizationId: input.run.organizationId,
          runId: input.run.id,
          threadId: input.run.threadId,
          toolCallId: call.toolCallId,
        },
        select: { id: true },
      })
      call.sessionId = session.id
      call.durable = createDurableLane({ prisma: input.prisma, sessionId: session.id })
      call.live = createLiveLane({
        publish: async (fragment) => {
          await input.realtimeTransport.publishSseEphemeral(
            input.run.threadId,
            'stream.document.delta',
            {
              content: fragment.content,
              offset: fragment.offset,
              runId: parseRunId(input.run.id),
              seq: fragment.seq,
              sessionId: session.id,
            },
          )
        },
      })
      await publish('stream.document.start', {
        agentId: parseAgentId(input.run.agentId),
        runId: parseRunId(input.run.id),
        sessionId: session.id,
        threadId: parseThreadId(input.run.threadId),
        toolCallId: call.toolCallId,
      })
    } catch (error) {
      console.warn('[worker] document stream session create failed', error)
    }
  }

  const publishMeta = async (call: TrackedCall): Promise<void> => {
    if (!call.sessionId || call.metaPublished) return
    const fields = call.scanner.fields()
    const title = fields.title
    const spaceId = fields.spaceId
    if (!title && !spaceId) return
    call.metaPublished = true

    let spaceName: string | undefined
    let parentTitle: string | undefined
    try {
      if (spaceId) {
        const space = await input.prisma.knowledgeSpace.findFirst({
          select: { name: true },
          where: { id: spaceId, organizationId: input.run.organizationId },
        })
        spaceName = space?.name
      }
      if (fields.parentPageId) {
        const parent = await input.prisma.knowledgePage.findFirst({
          select: { title: true },
          where: { id: fields.parentPageId, organizationId: input.run.organizationId },
        })
        parentTitle = parent?.title
      }
      await input.prisma.runDocumentSession.update({
        data: {
          parentPageId: fields.parentPageId ?? null,
          spaceId: spaceId ?? null,
          title: title ?? null,
        },
        where: { id: call.sessionId },
      })
    } catch (error) {
      console.warn('[worker] document stream meta resolve failed', error)
    }

    await publish('stream.document.meta', {
      parentPageId: fields.parentPageId,
      parentTitle,
      runId: parseRunId(input.run.id),
      sessionId: call.sessionId,
      spaceId,
      spaceName,
      title,
    })
  }

  const pump = (call: TrackedCall): void => {
    const committed = call.scanner.committed()
    if (committed.length <= call.publishedLength) return
    const fragment = {
      content: committed.slice(call.publishedLength),
      offset: call.publishedLength,
    }
    call.publishedLength = committed.length

    // Both lanes are fed synchronously and drain independently, so a slow
    // durable insert cannot delay the next live publish.
    const created = call.created
    if (created) {
      void created.then(() => {
        call.live?.enqueue(fragment)
        call.durable?.append(fragment)
        void publishMeta(call)
      })
    }
  }

  return {
    beginInvocation: (nextInvocationId) => {
      if (closed) return
      if (invocationId !== null && invocationId !== nextInvocationId) {
        // A replacement attempt: whatever was streaming is no longer the call
        // that will execute, so the popup must reset rather than keep growing.
        for (const call of byIndex.values()) {
          void terminalize(call, 'superseded')
        }
      }
      invocationId = nextInvocationId
      byIndex.clear()
    },

    handleToolCallDelta: (event) => {
      if (closed) return
      if (event.toolName !== KB_DOCUMENT_COMPOSE_TOOL_ID) return
      const currentInvocation = event.invocationId
      invocationId = currentInvocation

      let call = byIndex.get(event.index)
      if (!call) {
        call = {
          created: null,
          durable: null,
          live: null,
          metaPublished: false,
          publishedLength: 0,
          scanner: createPartialJsonScanner(MARKDOWN_ARGUMENT),
          sessionId: null,
          terminal: false,
          toolCallId: event.id,
        }
        byIndex.set(event.index, call)
        if (event.id) byToolCallId.set(event.id, call)
        call.created = createSession(call, currentInvocation)
      }
      // The id can arrive on a later fragment than the first.
      if (event.id && !byToolCallId.has(event.id)) {
        call.toolCallId = event.id
        byToolCallId.set(event.id, call)
      }

      call.scanner.push(event.text)
      if (call.scanner.error()) {
        // Duplicate or malformed target key: the document being watched can no
        // longer be trusted to match what would be saved.
        void terminalize(call, 'invalid_args')
        byIndex.delete(event.index)
        return
      }
      pump(call)
    },

    settle: async (toolCallId) => {
      const call = byToolCallId.get(toolCallId)
      if (!call) return null
      await call.created
      await call.live?.settle()
      await call.durable?.settle()
      if (!call.sessionId) return null
      const fields = call.scanner.fields()
      return {
        markdown: call.scanner.committed(),
        parentPageId: fields.parentPageId ?? null,
        sessionId: call.sessionId,
        spaceId: fields.spaceId ?? null,
        title: fields.title ?? null,
      }
    },

    hasOpenSession: () => {
      for (const call of byToolCallId.values()) {
        if (!call.terminal) return true
      }
      return false
    },

    finalizeOutstanding: async (reason) => {
      for (const call of byToolCallId.values()) {
        await call.created
        await call.live?.settle()
        await call.durable?.settle()
        await terminalize(call, reason)
      }
    },

    close: async () => {
      if (closed) return
      closed = true
      for (const call of byToolCallId.values()) {
        await call.created
        await call.live?.settle()
        await call.durable?.settle()
      }
    },
  }
}
