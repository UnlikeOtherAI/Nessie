import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import type { AuthorizedActionContext } from '@nessie/schemas'
import { activateAgentTodoTemplate } from '@nessie/workspace-admin'
import { emitAuditEvent } from './audit.js'
import { createKnowledgePublicationAttention } from './push-attention.js'

// The minimal shape runApprovalEffect needs from an approval row — matches
// the return of approvals.ts's mapApproval structurally, so callers can pass
// either the mapped DTO or a raw Prisma row without an explicit cast.
export type ApprovalForEffect = {
  id: string
  action: string
  context: Record<string, unknown> | null
}

export type ApprovalEffectResult = {
  note?: string
}

const KnowledgePagePublishContextSchema = z.object({
  pageId: z.string().uuid(),
  versionId: z.string().uuid(),
  spaceId: z.string().uuid(),
  title: z.string(),
})
const AgentTodoTemplatePublishContextSchema = z.object({
  templateId: z.string().uuid(),
  version: z.number().int().positive(),
})

// Executes the actual publish once a human has approved the request. Guards
// against staleness: the draft may have picked up a newer version between
// the request being filed and being resolved, in which case publishing the
// version named in the (now stale) approval would silently ship the wrong
// content — so this refuses and asks for a fresh request instead.
const runKnowledgePagePublishEffect = async (
  prisma: PrismaClient,
  approval: ApprovalForEffect,
  actorContext: AuthorizedActionContext,
): Promise<ApprovalEffectResult> => {
  const parsed = KnowledgePagePublishContextSchema.safeParse(approval.context)
  if (!parsed.success) {
    return { note: 'approval context malformed — publish not attempted' }
  }
  const { pageId, versionId } = parsed.data

  const provider = createNativeKnowledgeProvider(prisma, {
    onPagePublished: async (tx, event) => createKnowledgePublicationAttention(tx, event),
  })
  const page = await provider.getPage(actorContext.tenant.organizationId, pageId)
  if (!page) {
    return { note: 'page no longer exists' }
  }
  if (page.latestVersion?.id !== versionId) {
    return { note: 'draft superseded by a newer version — re-request publication' }
  }

  const published = await provider.publishPage({
    actorUserId: actorContext.actor.actorType === 'user' ? actorContext.actor.actorId : null,
    organizationId: actorContext.tenant.organizationId,
    pageId,
  })
  if (!published) {
    return { note: 'page no longer exists' }
  }

  await emitAuditEvent(prisma, {
    actorContext,
    action: 'kb.page.published',
    resourceType: 'knowledge_page',
    resourceId: published.id,
    outcome: 'success',
    metadata: { approvalId: approval.id, publishedVersionId: published.publishedVersionId },
  })

  return { note: 'published' }
}

const runAgentTodoTemplatePublishEffect = async (
  prisma: PrismaClient,
  approval: ApprovalForEffect,
  actorContext: AuthorizedActionContext,
): Promise<ApprovalEffectResult> => {
  const parsed = AgentTodoTemplatePublishContextSchema.safeParse(approval.context)
  if (!parsed.success) return { note: 'approval context malformed — publication not attempted' }
  const template = await prisma.agentTodoTemplate.findFirst({
    select: { agentId: true },
    where: {
      id: parsed.data.templateId,
      organizationId: actorContext.tenant.organizationId,
    },
  })
  if (!template) return { note: 'template no longer exists' }
  const published = await activateAgentTodoTemplate(prisma, {
    agentId: template.agentId,
    organizationId: actorContext.tenant.organizationId,
    templateId: parsed.data.templateId,
    version: parsed.data.version,
  })
  if (!published) return { note: 'draft superseded or already handled — publication not attempted' }

  await emitAuditEvent(prisma, {
    actorContext,
    action: 'agent.todo_template.published',
    metadata: { approvalId: approval.id, version: published.version },
    outcome: 'success',
    resourceId: published.id,
    resourceType: 'agent_todo_template',
  })
  // The approval claim is deliberately separate from this effect. If a process
  // crashes here, an owner can publish or edit the draft in the Designer.
  return { note: 'published' }
}

// Runs the side effect an approved ApprovalRequest triggers, dispatched on
// its `action`. Unknown actions (approvals that gate something other than a
// concrete follow-up mutation) are a deliberate no-op — approving them is the
// entire effect.
export const runApprovalEffect = async (
  prisma: PrismaClient,
  approval: ApprovalForEffect,
  actorContext: AuthorizedActionContext,
): Promise<ApprovalEffectResult> => {
  switch (approval.action) {
    case 'knowledge.page.publish':
      return runKnowledgePagePublishEffect(prisma, approval, actorContext)
    case 'agent.todo_template.publish':
      return runAgentTodoTemplatePublishEffect(prisma, approval, actorContext)
    default:
      return {}
  }
}
