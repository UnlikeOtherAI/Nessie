import type { PrismaClient } from '@prisma/client'

/**
 * Which agent-saved versions may wake a document trigger's agent
 * (docs/standards/document-triggers.md → "The agent's own edits never wake
 * it"). A review can edit the document it reviews, so every agent save that
 * could have come from a review is left out, whatever project it was in:
 *
 * - the trigger's own agent's, always;
 * - any other agent's unless the trigger sets `includeAgentEdits`;
 * - even then, never an agent that has an enabled `document_changed` trigger
 *   **anywhere in the organisation** — two reviewers of different projects
 *   that both include agent edits would otherwise wake each other forever;
 * - and never a version an agent saved while a run a document trigger started
 *   was live for it — its review thread's run, or a ticket's work woken by a
 *   document change — even after that trigger was switched off.
 *
 * All structural: who saved the version, which triggers exist, which runs were
 * live. Nothing reads what a version says.
 */

type AgentVersion = { authorType: string; authorId: string; createdAt: Date }

/** The agents with an enabled document trigger in the organisation: they review, so they never count. */
const reviewingAgents = async (
  prisma: PrismaClient,
  organizationId: string,
  agentIds: readonly string[],
): Promise<Set<string>> => new Set((await prisma.agentTrigger.findMany({
  where: {
    agentId: { in: [...agentIds] },
    type: 'document_changed',
    enabled: true,
    agent: { organizationId },
  },
  select: { agentId: true },
})).flatMap((trigger) => (trigger.agentId ? [trigger.agentId] : [])))

/** Runs a document trigger started, per agent: its own, or one its delivery woke. */
const documentRuns = async (prisma: PrismaClient, agentIds: readonly string[], since: Date) =>
  prisma.run.findMany({
    where: {
      agentId: { in: [...agentIds] },
      OR: [{ finishedAt: null }, { finishedAt: { gte: since } }],
      AND: [{
        OR: [
          { trigger: { type: 'document_changed' } },
          { triggerDelivery: { trigger: { type: 'document_changed' } } },
        ],
      }],
    },
    select: { agentId: true, createdAt: true, finishedAt: true },
  })

/**
 * The versions that may wake the agent: every person's, and an agent's only
 * where the rules above allow it.
 */
export const wakingVersions = async <V extends AgentVersion>(
  prisma: PrismaClient,
  input: { organizationId: string; agentId: string; includeAgentEdits: boolean; versions: readonly V[] },
): Promise<V[]> => {
  const agentSaved = input.versions.filter((version) => version.authorType === 'agent')
  const others = [...new Set(agentSaved.map((version) => version.authorId).filter((id) => id !== input.agentId))]
  if (!input.includeAgentEdits || others.length === 0) {
    return input.versions.filter((version) => version.authorType !== 'agent')
  }
  const earliest = new Date(Math.min(...agentSaved.map((version) => version.createdAt.getTime())))
  const [reviewers, runs] = await Promise.all([
    reviewingAgents(prisma, input.organizationId, others),
    documentRuns(prisma, others, earliest),
  ])
  const savedInAReview = (version: V): boolean => runs.some((run) =>
    run.agentId === version.authorId
    && run.createdAt <= version.createdAt
    && (run.finishedAt === null || run.finishedAt >= version.createdAt))
  return input.versions.filter((version) =>
    version.authorType !== 'agent'
    || (version.authorId !== input.agentId && !reviewers.has(version.authorId) && !savedInAReview(version)))
}
