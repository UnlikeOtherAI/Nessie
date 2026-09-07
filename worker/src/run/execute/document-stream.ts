import type { PrismaClient } from '@prisma/client'
import type { PgRealtimeTransport } from '@nessie/runtime'
import {
  createPartialJsonEditScanner,
  createPartialJsonScanner,
  parseAgentId,
  parseRunId,
  parseThreadId,
  type DocumentStreamErrorReason,
  type PartialJsonEditScanner,
  type PartialJsonScanner,
} from '@nessie/schemas'
import { KB_DOCUMENT_COMPOSE_TOOL_ID, KB_DOCUMENT_EDIT_TOOL_ID } from '@nessie/runtime'
import { settleDocumentSession } from './document-session-claim.js'
import { createDurableLane, createLiveLane } from './document-stream-lanes.js'
import { createDocumentTargetAnnouncer } from './document-stream-target.js'
import { createDocumentEditTracker, type DocumentEditTracker } from './document-stream-edit.js'
import { createDocumentStreamDisclosureGate } from './document-stream-disclosure.js'
import type { BasisScope } from './disclosure-basis.js'

/** The argument whose value is the document body. */
const MARKDOWN_ARGUMENT = 'markdown'

type RunContext = {
  agentId: string
  id: string
  organizationId: string
  threadId: string
}

export type DocumentSessionHandle = {
  /**
   * The claim the session was opened under, carried out to the save paths so
   * their writes ride the same fence the recorder's do
   * (`document-session-claim.ts`).
   */
  claimToken: string | null
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
  mode: 'compose' | 'edit'
  /** Read once, when the session is opened; every write on it uses this value. */
  claimToken: string | null
  pageId: string | null
  editScanner: PartialJsonEditScanner | null
  tracker: DocumentEditTracker | null
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
  /**
   * The run-execution claim to open each session under —
   * `runs.executor_token` as this execution holds it. Read lazily, per session,
   * because the recorders are built before the run is claimed; a run executing
   * without a claim (an unfenced path, a test) returns null and its sessions
   * are written unfenced, exactly as they were. See
   * `document-session-claim.ts`.
   */
  claimToken: () => string | null
  getRestrictionBasis: () => readonly BasisScope[]
  isRestricted: () => boolean
  persistRestrictionBasis: (basis: readonly BasisScope[]) => Promise<void>
  prisma: PrismaClient
  realtimeTransport: Pick<PgRealtimeTransport, 'publishSse' | 'publishSseEphemeral'>
  run: RunContext
  /**
   * Reads a `.md` document's current text. An edit session needs the document
   * it is changing before it can locate anything in it, so this is awaited
   * before the session is announced.
   */
  loadDocument?: (pageId: string) => Promise<
    { content: string; parentPageId: string | null; spaceId: string; title: string } | null
  >
}

/**
 * Turns in-flight compose/edit arguments into a live preview; the tool still
 * authorizes and saves. Failures are swallowed — a broken preview must never
 * fail a run that is otherwise writing a perfectly good document.
 */
export const createDocumentStreamRecorder = (
  input: RecorderInput,
): DocumentStreamRecorder => {
  const byIndex = new Map<number, TrackedCall>()
  const byToolCallId = new Map<string, TrackedCall>()
  let invocationId: string | null = null
  let closed = false
  const disclosure = createDocumentStreamDisclosureGate(input)

  const publish = async (
    event: 'stream.document.start' | 'stream.document.meta' | 'stream.document.done'
      | 'stream.document.error' | 'stream.document.edit',
    data: Parameters<PgRealtimeTransport['publishSse']>[2],
  ): Promise<void> => {
    try {
      await input.realtimeTransport.publishSse(input.run.threadId, event, data)
    } catch (error) {
      console.warn('[worker] document stream publish failed', event, error)
    }
  }

  // Where the document is going — the session's target columns, the names the
  // address bar shows, and the `stream.document.meta` event that carries them.
  const target = createDocumentTargetAnnouncer({
    disclosure,
    organizationId: input.run.organizationId,
    prisma: input.prisma,
    publish,
    runId: input.run.id,
  })

  const appendDurable = (
    call: TrackedCall,
    fragment: { content: string; offset: number },
  ): void => disclosure.appendDurable(() => call.durable?.append(fragment))

  const terminalize = async (
    call: TrackedCall,
    reason: DocumentStreamErrorReason,
  ): Promise<void> => {
    try {
      if (call.terminal || !call.sessionId) return
      call.terminal = true
      const sessionId = call.sessionId
      // Two terminalisers ride this one write: the recorder's own (a replaced
      // invocation, unreadable arguments) and `finalizeOutstanding`'s, which is
      // the failure path. Fenced on the claim, so a superseded executor cannot
      // report a document lost that its successor is still writing; and still
      // scoped to the open statuses, because a save that has already won is the
      // completed document and this is only a report about one.
      const settled = await settleDocumentSession(input.prisma, {
        claimToken: call.claimToken,
        data: {
          errorReason: reason,
          finishedAt: new Date(),
          status: reason === 'cancelled' ? 'cancelled' : 'failed',
        },
        from: ['saving', 'streaming'],
        sessionId,
        settle: `terminalize (${reason})`,
      })
      if (settled !== 'applied') return
      const restricted = disclosure.isRestricted()
      if (restricted) await disclosure.beforeRestrictedReadable()
      await publish('stream.document.error', {
        reason,
        runId: parseRunId(input.run.id),
        sessionId,
        ...(restricted ? { restricted: true } : {}),
      })
    } catch (error) {
      console.warn('[worker] document stream terminalize failed', error)
    }
  }

  const createSession = async (
    call: TrackedCall,
    currentInvocation: string,
    base: { content: string; parentPageId: string | null; spaceId: string; title: string } | null,
  ): Promise<void> => {
    const baseDocument = base?.content ?? null
    // Read here rather than at construction, and stored on the call: from this
    // point every write about this session names the execution that opened it.
    // The insert itself is not fenced — there is no row yet to fence on — and it
    // does not need to be: a session a superseded executor opens carries a claim
    // the run no longer holds, which is the reaper's first arm.
    call.claimToken = input.claimToken()
    try {
      if (disclosure.isRestricted()) await disclosure.beforeRestrictedReadable()
      const session = await input.prisma.runDocumentSession.create({
        data: {
          agentId: input.run.agentId,
          claimToken: call.claimToken,
          invocationId: currentInvocation,
          organizationId: input.run.organizationId,
          pageId: call.mode === 'edit' ? call.pageId : null,
          runId: input.run.id,
          threadId: input.run.threadId,
          toolCallId: call.toolCallId,
        },
        select: { id: true },
      })
      call.sessionId = session.id
      if (call.mode === 'edit') {
        call.tracker = createDocumentEditTracker(baseDocument ?? '')
        // An edit changes text in the middle of a document, which a log of
        // appends cannot express — so the durable lane stores whole snapshots.
        call.durable = createDurableLane({
          mode: 'snapshot',
          prisma: input.prisma,
          readSnapshot: () => call.tracker?.composed() ?? '',
          sessionId: session.id,
        })
        appendDurable(call, { content: baseDocument ?? '', offset: 0 })
        await disclosure.settleDurableFeed()
        await call.durable.settle()
      } else {
        call.durable = createDurableLane({ prisma: input.prisma, sessionId: session.id })
      }
      call.live = createLiveLane({
        publish: async (fragment) => {
          if (disclosure.isRestricted()) {
            await disclosure.beforeRestrictedReadable()
            return
          }
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
      if (call.mode === 'edit' && base) await target.edit(call, session.id, base)
      const restricted = disclosure.isRestricted()
      await publish('stream.document.start', {
        agentId: parseAgentId(input.run.agentId),
        mode: call.mode,
        runId: parseRunId(input.run.id),
        sessionId: session.id,
        threadId: parseThreadId(input.run.threadId),
        toolCallId: call.toolCallId,
        ...(restricted ? { restricted: true } : {}),
      })
      if (call.mode === 'edit' && base) await target.publishEdit(session.id, base)
    } catch (error) {
      console.warn('[worker] document stream session create failed', error)
    }
  }

  const pumpEdit = (call: TrackedCall): void => {
    const scanner = call.editScanner
    const tracker = call.tracker
    if (!scanner || !tracker) return
    tracker.pump(scanner.edits(), {
      beginEdit: ({ editIndex, offset, removeLength }) => {
        if (!disclosure.isRestricted()) {
          void publish('stream.document.edit', {
            editIndex,
            offset,
            removeLength,
            runId: parseRunId(input.run.id),
            sessionId: call.sessionId!,
          })
        }
        // The removal alone changes the document, so the snapshot is stale
        // even before any replacement text arrives.
        appendDurable(call, { content: '', offset })
      },
      insert: ({ content, offset }) => {
        call.live?.enqueue({ content, offset })
        appendDurable(call, { content, offset })
      },
    })
  }

  const pump = (call: TrackedCall): void => {
    if (call.mode === 'edit') {
      const created = call.created
      if (created) void created.then(() => pumpEdit(call))
      return
    }
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
        appendDurable(call, fragment)
        void target.compose(call)
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
      const mode = event.toolName === KB_DOCUMENT_COMPOSE_TOOL_ID
        ? 'compose'
        : event.toolName === KB_DOCUMENT_EDIT_TOOL_ID
          ? 'edit'
          : null
      if (!mode) return
      const currentInvocation = event.invocationId
      invocationId = currentInvocation

      let call = byIndex.get(event.index)
      if (!call) {
        call = {
          claimToken: null,
          created: null,
          durable: null,
          editScanner: mode === 'edit' ? createPartialJsonEditScanner() : null,
          live: null,
          metaPublished: false,
          mode,
          pageId: null,
          publishedLength: 0,
          scanner: createPartialJsonScanner(MARKDOWN_ARGUMENT),
          sessionId: null,
          terminal: false,
          toolCallId: event.id,
          tracker: null,
        }
        byIndex.set(event.index, call)
        if (event.id) byToolCallId.set(event.id, call)
        if (mode === 'compose') {
          call.created = createSession(call, currentInvocation, null)
        }
      }
      // The id can arrive on a later fragment than the first.
      if (event.id && !byToolCallId.has(event.id)) {
        call.toolCallId = event.id
        byToolCallId.set(event.id, call)
      }

      const scanner = call.mode === 'edit' ? call.editScanner : call.scanner
      scanner?.push(event.text)
      if (scanner?.error()) {
        // A duplicate or malformed target key means the text being watched can
        // no longer be trusted to match what would be saved.
        void terminalize(call, 'invalid_args')
        byIndex.delete(event.index)
        return
      }

      // An edit session cannot open until it knows which document it edits —
      // the base text is what every offset in the stream is relative to.
      if (call.mode === 'edit' && !call.created) {
        const pageId = call.editScanner?.fields().pageId
        if (!pageId) return
        call.pageId = pageId
        const tracked = call
        call.created = (async () => {
          let base = null as Awaited<ReturnType<NonNullable<typeof input.loadDocument>>>
          try {
            base = (await input.loadDocument?.(pageId)) ?? null
          } catch (error) {
            console.warn('[worker] document stream base load failed', error)
          }
          await createSession(tracked, currentInvocation, base)
        })()
      }

      pump(call)
    },

    settle: async (toolCallId) => {
      const call = byToolCallId.get(toolCallId)
      if (!call) return null
      await call.created
      await call.live?.settle()
      await disclosure.settleDurableFeed()
      await call.durable?.settle()
      if (!call.sessionId) return null
      if (call.mode === 'edit') {
        return {
          claimToken: call.claimToken,
          markdown: call.tracker?.composed() ?? '',
          parentPageId: null,
          sessionId: call.sessionId,
          spaceId: null,
          title: null,
        }
      }
      const fields = call.scanner.fields()
      return {
        claimToken: call.claimToken,
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
        await disclosure.settleDurableFeed()
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
        await disclosure.settleDurableFeed()
        await call.durable?.settle()
      }
    },
  }
}
