import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { createNativeKnowledgeProvider } from '@nessie/knowledge'
import {
  APPROVAL_ACTIONS,
  EFFECT_FREE_APPROVAL_ACTIONS,
  type AuthorizedActionContext,
} from '@nessie/schemas'
import { activateAgentTodoTemplate, documentTriggerOnPagePublished } from '@nessie/team-admin'
import { emitAuditEvent } from './audit.js'
import { resumeRunFromApproval } from './approval-resume.js'
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
const WorkflowTemplateAdoptContextSchema = z.object({
  workflowTemplateId: z.string().uuid(),
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

  // The publication's attention, and the quiet window of any document
  // trigger that fires on publish — the knowledge routes' own publish hooks.
  const provider = createNativeKnowledgeProvider(prisma, {
    onPagePublished: async (tx, event) => {
      await createKnowledgePublicationAttention(tx, event)
      await documentTriggerOnPagePublished(tx, event)
    },
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

const runWorkflowTemplateAdoptEffect = async (
  prisma: PrismaClient,
  approval: ApprovalForEffect,
  actorContext: AuthorizedActionContext,
): Promise<ApprovalEffectResult> => {
  const parsed = WorkflowTemplateAdoptContextSchema.safeParse(approval.context)
  if (!parsed.success) return { note: 'approval context malformed — adoption not attempted' }
  const adopted = await prisma.workflowTemplate.updateMany({
    data: { adoptedAt: new Date() },
    where: {
      id: parsed.data.workflowTemplateId,
      organizationId: actorContext.tenant.organizationId,
      source: 'demonstration',
      adoptedAt: null,
    },
  })
  if (adopted.count === 0) return { note: 'learned workflow no longer needs adoption' }
  await emitAuditEvent(prisma, {
    actorContext,
    action: 'workflow.template.adopted',
    metadata: { approvalId: approval.id },
    outcome: 'success',
    resourceId: parsed.data.workflowTemplateId,
    resourceType: 'workflow_template',
  })
  return { note: 'learned workflow adopted' }
}

// Runs the side effect an approved ApprovalRequest triggers, dispatched on
// its `action`. The vocabulary is closed (`APPROVAL_ACTIONS` in
// `@nessie/schemas`): an action in `EFFECT_FREE_APPROVAL_ACTIONS` is
// deliberately a no-op — approving it IS the entire effect — and anything
// else the switch does not know is unrecognised, not effect-free.
//
// Unrecognised is loud, and loud here means *thrown*, not just logged: the
// atomic claim in `resolveApprovalRequest` has already committed when this
// runs, so throwing cannot un-approve the request — the caller's catch
// records the failure on the approval's resolution note, which is exactly
// where a human looks when the thing they approved did not happen. The old
// `default: return {}` made a misspelled action indistinguishable from a
// deliberate no-op: request filed, human approves, nothing happens,
// successfully, with no error — the worst failure mode an approval gate has.
export const runApprovalEffect = async (
  prisma: PrismaClient,
  approval: ApprovalForEffect,
  actorContext: AuthorizedActionContext,
): Promise<ApprovalEffectResult> => {
  switch (approval.action) {
    case APPROVAL_ACTIONS.toolInvoke: {
      const result = await resumeRunFromApproval(prisma, approval.id)
      switch (result.kind) {
        case 'resumed':
          return { note: `resumed run ${result.runId}` }
        case 'run_not_waiting':
          return { note: 'run no longer waiting' }
        case 'already_resumed':
          return { note: 'checkpoint was already consumed' }
        case 'busy':
          return { note: 'thread became busy before resume' }
        case 'invalid_resume_state':
          return { note: 'resume state is invalid — run not resumed' }
      }
    }
    case APPROVAL_ACTIONS.knowledgePagePublish:
      return runKnowledgePagePublishEffect(prisma, approval, actorContext)
    case APPROVAL_ACTIONS.agentTodoTemplatePublish:
      return runAgentTodoTemplatePublishEffect(prisma, approval, actorContext)
    case APPROVAL_ACTIONS.workflowTemplateAdopt:
      return runWorkflowTemplateAdoptEffect(prisma, approval, actorContext)
    default: {
      if ((EFFECT_FREE_APPROVAL_ACTIONS as readonly string[]).includes(approval.action)) {
        return {}
      }
      console.error(
        '[approval-effects] unrecognised approval action — approving it ran no effect:',
        approval.action,
        approval.id,
      )
      throw new Error(
        `Approval action '${approval.action}' is not recognised: it is neither an action `
        + 'with an effect nor a declared effect-free one. If it is deliberately effect-free, '
        + 'add it to EFFECT_FREE_APPROVAL_ACTIONS; otherwise this is a misspelled action.',
      )
    }
  }
}
