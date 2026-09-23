import type { PrismaClient } from '@prisma/client'

import { CODING_SESSION_TOOL_NAME_SET } from './coding-session-tools.js'
import type { BasisScope, ConsumedSourceSink } from './execute/disclosure-basis.js'
import { executorToolName } from './executor-tool-descriptors.js'

/**
 * Host program output is the launch conversation's.
 *
 * A local program on the person's machine answers from that machine: a real
 * browser profile, private repositories, whatever the owner's session can
 * reach. Nothing about it is public web, so every `mcp.*` result enters the
 * run's disclosure basis with the scope of the conversation the person
 * launched local apps in. Launching there is the person's consent to show the
 * program's output to that conversation's audience, and nowhere else: a reply
 * in the same conversation is unaffected, a write onto the board of the
 * project a public channel belongs to is allowed (`assertProjectWriteDestination`),
 * and every other destination is contained by the basis.
 *
 * The scope is stamped even when the channel is public, unlike a transcript
 * turn's: a public room's history is the organisation's to read, but the
 * program's output was only ever consented to that room.
 *
 * See docs/standards/disclosure-boundaries.md and executor-local-mcp.md.
 */
export type ExecutorHostOutputDisclosure = {
  /** The launch conversation's scope. */
  launchScope: BasisScope
  sink: ConsumedSourceSink
}

/** The operations that return a local program's own output. */
export const HOST_OUTPUT_OPERATION_KEYS: ReadonlySet<string> = new Set(['mcp.tools', 'mcp.call'])

/**
 * The launch conversation of a run's own local-apps launch: the run's channel.
 * A launch carried across a person's follow-ups would name the conversation it
 * was made in instead.
 */
export const launchConversationScope = (channelId: string): BasisScope => ({
  scopeId: channelId,
  scopeType: 'channel',
})

// Their tool names too: a ToolCall keeps its name when its binding is gone.
// The coding-session tools are `mcp.call`s under names of their own.
const HOST_OUTPUT_TOOL_NAMES = [
  ...[...HOST_OUTPUT_OPERATION_KEYS].map(executorToolName),
  ...CODING_SESSION_TOOL_NAME_SET,
]

// Far past any real chain of "keep going"; a longer one is stamped anyway.
const MAX_CHECKPOINT_CHAIN_RUNS = 64

/**
 * The host-output stamps a checkpoint carries into the run that resumes it.
 *
 * A checkpoint note is written from its run's raw transcript, verbatim program
 * output included, but the basis it is persisted with is the run's reply
 * basis, which subtracts the run's own channel — and that channel is exactly
 * the launch stamp. A continuation, a new run with no executor bindings of its
 * own, would then hold the program's output with no stamp at all and could
 * post it to another channel, a DM or another project's board.
 *
 * So the stamp is re-derived, structurally: the run that wrote the checkpoint
 * read host output if it has a ToolCall on an `mcp.*` operation, and so did
 * every run whose checkpoint it consumed in turn, back along the chain — the
 * second "keep going" must not lose what the first carried. Each such run's
 * own channel is its launch conversation. Not persisted into the run's basis
 * rows, which would restrict a public room's own replies from the people who
 * can read the room; added to the resuming run's sink instead.
 */
export const loadCheckpointHostOutputScopes = async (
  prisma: Pick<PrismaClient, 'run' | 'runCheckpoint' | 'toolCall'>,
  sourceRunId: string,
): Promise<BasisScope[]> => {
  const scopes = new Map<string, BasisScope>()
  const stamp = (channelId: string): void => {
    scopes.set(channelId, launchConversationScope(channelId))
  }
  const visited = new Set<string>()
  let frontier = [sourceRunId]
  while (frontier.length > 0) {
    if (visited.size >= MAX_CHECKPOINT_CHAIN_RUNS) {
      const source = await prisma.run.findUnique({
        where: { id: sourceRunId },
        select: { thread: { select: { channelId: true } } },
      })
      if (source) stamp(source.thread.channelId)
      break
    }
    const runIds = frontier.filter((runId) => !visited.has(runId))
    for (const runId of runIds) visited.add(runId)
    if (runIds.length === 0) break
    const readers = await prisma.toolCall.findMany({
      where: {
        runId: { in: runIds },
        OR: [
          { executorBinding: { operationKey: { in: [...HOST_OUTPUT_OPERATION_KEYS] } } },
          { toolName: { in: HOST_OUTPUT_TOOL_NAMES } },
        ],
      },
      distinct: ['runId'],
      select: { run: { select: { thread: { select: { channelId: true } } } } },
    })
    for (const reader of readers) stamp(reader.run.thread.channelId)
    const consumed = await prisma.runCheckpoint.findMany({
      where: { consumedByRunId: { in: runIds } },
      select: { runId: true },
    })
    frontier = consumed.map(({ runId }) => runId)
  }
  return [...scopes.values()]
}
