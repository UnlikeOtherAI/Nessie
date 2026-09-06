import { fileServiceFor } from '../file-service.js'
import { readMarkdownDocument } from '../pa-tools/knowledge-document-io.js'
import { persistRunBasis, runReplyBasis, runReplyIsRestricted } from './agent-message.js'
import { createDocumentStreamRecorder, type DocumentStreamRecorder } from './document-stream.js'
import { createThinkingRecorder, type ThinkingRecorder } from './thinking-recorder.js'
import type { ExecutionDependencies, RunContext } from './types.js'

/**
 * The two live recorders a run writes into, built together because they are
 * governed by the same two rules: both must exist BEFORE the first provider
 * chunk — a thought or a document delta that arrives with no recorder is simply
 * lost — and every exit path must settle them, including a crash, a cancel and
 * a budget stop. The run job creates them outside its `try` and closes them in
 * its `finally` for exactly that reason.
 *
 * Both consult the run's live disclosure state rather than a snapshot of it:
 * the restriction can be established part-way through a run (the first
 * privileged read), and a recorder that had captured the answer as unrestricted
 * would publish it that way.
 */
export type RunRecorders = {
  documentStream: DocumentStreamRecorder
  /**
   * `deps` with the document stream attached — what the inference and the agent
   * loop take, so a provider chunk reaches the composition without either of
   * them being handed a second parameter.
   */
  executionDeps: ExecutionDependencies
  thinkingRecorder: ThinkingRecorder
}

export const createRunRecorders = (
  deps: ExecutionDependencies,
  context: RunContext,
): RunRecorders => {
  const organizationId = String(context.channel.organizationId)
  // Durable thought log + coalesced live thinking events.
  const thinkingRecorder = createThinkingRecorder({
    isRestricted: () => runReplyIsRestricted(context),
    prisma: deps.prisma,
    realtimeTransport: deps.realtimeTransport,
    runId: context.run.id,
    threadId: context.run.threadId,
  })

  // Live document composition (`kb_document_compose`).
  const documentStream = createDocumentStreamRecorder({
    getRestrictionBasis: () => runReplyBasis(context),
    isRestricted: () => runReplyIsRestricted(context),
    loadDocument: async (pageId) => readMarkdownDocument(
      deps.prisma,
      fileServiceFor(deps.prisma),
      organizationId,
      pageId,
      context,
    ),
    prisma: deps.prisma,
    persistRestrictionBasis: (basis) => persistRunBasis(deps.prisma, {
      basis,
      organizationId,
      runId: context.run.id,
    }),
    realtimeTransport: deps.realtimeTransport,
    run: {
      agentId: context.agent.id,
      id: context.run.id,
      organizationId,
      threadId: context.run.threadId,
    },
  })

  return { documentStream, executionDeps: { ...deps, documentStream }, thinkingRecorder }
}
