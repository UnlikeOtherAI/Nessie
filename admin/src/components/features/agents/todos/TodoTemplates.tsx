import { useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { AgentTodoTemplateRecord, AgentTodoTemplateStepInput } from '@nessie/schemas'

import {
  useArchiveAgentTodoTemplate,
  useCreateAgentTodoTemplate,
  useUpdateAgentTodoTemplate,
} from '../../../../facades/agent-todos/hooks'
import { useApprovalRequests, useResolveApproval, type ApprovalRequest } from '../../../../facades/approvals/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { useToasts } from '../../../../providers/ToastProvider'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { QueryState } from '../../../shared/QueryState'
import { useIsOwner } from '../../../../facades/auth/hooks'
import { TodoTemplateEditor } from './TodoTemplateEditor'
import { TodoTemplateCard } from './TodoTemplateCard'
import { useChannels } from '../../../../facades/channels/hooks'
import { useAgentTriggers } from '../../../../facades/triggers/hooks'

type TodoTemplatesProps = {
  agent: AgentRecord
  query: UseQueryResult<AgentTodoTemplateRecord[]>
}

export const TodoTemplates = ({ agent, query }: TodoTemplatesProps) => {
  const isOwner = useIsOwner()
  const templates = query.data ?? []
  const { pushToast } = useToasts()
  const createTemplate = useCreateAgentTodoTemplate()
  const updateTemplate = useUpdateAgentTodoTemplate()
  const archiveTemplate = useArchiveAgentTodoTemplate()
  const approvals = useApprovalRequests()
  const resolveApproval = useResolveApproval()
  const { data: channels = [] } = useChannels()
  const { data: triggers = [] } = useAgentTriggers(agent.id, isOwner)
  const [editingTemplate, setEditingTemplate] = useState<AgentTodoTemplateRecord | null | undefined>()

  const refuseOwnerAction = () => {
    pushToast({
      body: 'Only organization owners can create, edit, or archive to-do templates.',
      title: 'Template changes need owner access',
    })
  }

  // Errors are the editor's to show — it stays open and renders them on the
  // field the server named, per `toFormErrors` — so this deliberately does
  // not catch: a rejection here reaches `TodoTemplateEditor`'s own submit
  // handler.
  const saveTemplate = async (input: {
    description: string | null
    name: string
    steps: AgentTodoTemplateStepInput[]
  }) => {
    if (editingTemplate) {
      await updateTemplate.mutateAsync({
        ...input,
        agentId: agent.id,
        templateId: editingTemplate.id,
        version: editingTemplate.version,
      })
    } else {
      await createTemplate.mutateAsync({
        ...input,
        agentId: agent.id,
        // Person-authored templates are usable immediately. Drafts arrive
        // through the later agent-proposal flow, not a second authoring path.
        status: 'active',
      })
    }
    setEditingTemplate(undefined)
  }

  const archive = (template: AgentTodoTemplateRecord) => {
    archiveTemplate.mutate(
      { agentId: agent.id, templateId: template.id },
      {
        onError: (error) => pushToast({
          body: error.message,
          title: 'Could not archive template',
        }),
      },
    )
  }

  const editorIsOpen = editingTemplate !== undefined
  const proposalFor = (templateId: string): ApprovalRequest | undefined =>
    approvals.data?.find((approval) => {
      const context = approval.context
      return approval.action === 'agent.todo_template.publish'
        && context?.templateId === templateId
    })

  return (
    <section className="grid gap-4" data-testid="agent-todo-templates">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <SectionLabel>Templates</SectionLabel>
          <p className="mt-1 text-sm leading-6 text-[color:var(--tx2)]">
            Reusable checklists for this agent. Step instructions are visible to everyone
            who can see the agent, so never put secrets in them.
          </p>
        </div>
        <button
          className="admin-button admin-button-primary"
          onClick={() => {
            if (isOwner) setEditingTemplate(null)
            else refuseOwnerAction()
          }}
          type="button"
        >
          New template
        </button>
      </div>

      {editorIsOpen ? (
        <TodoTemplateEditor
          onCancel={() => setEditingTemplate(undefined)}
          onSave={saveTemplate}
          saving={createTemplate.isPending || updateTemplate.isPending}
          template={editingTemplate ?? undefined}
        />
      ) : null}

      <QueryState
        className="py-4"
        emptyLabel={
          isOwner
            ? 'Create a template to give this agent a reusable checklist.'
            : 'No templates exist yet. An organization owner can add a reusable checklist here.'
        }
        errorLabel="Templates could not be loaded."
        isEmpty={templates.length === 0}
        loadingLabel="Loading templates…"
        query={query}
      >
        {() => (
          <div className="grid gap-3">
            {templates.map((template) => (
              <TodoTemplateCard
                isOwner={isOwner}
                agent={agent}
                channels={channels}
                key={template.id}
                onArchive={archive}
                onEdit={setEditingTemplate}
                onRefuseOwnerAction={refuseOwnerAction}
                onResolveProposal={(approval, resolution) => resolveApproval.mutate(
                  { id: approval.id, resolution },
                  { onError: (error) => pushToast({ body: error.message, title: 'Could not resolve proposal' }) },
                )}
                proposal={proposalFor(template.id)}
                template={template}
                trigger={triggers.find((trigger) => trigger.config.todoTemplateId === template.id)}
              />
            ))}
          </div>
        )}
      </QueryState>
    </section>
  )
}
