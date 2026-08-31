import type { AgentTodoTemplateRecord } from '@nessie/schemas'

import { Pill } from '../../../primitives/Pill'
import type { ApprovalRequest } from '../../../../facades/approvals/hooks'
import { templateStatusTone } from './todo-presentation'

type TodoTemplateCardProps = {
  isOwner: boolean
  onArchive: (template: AgentTodoTemplateRecord) => void
  onEdit: (template: AgentTodoTemplateRecord) => void
  onRefuseOwnerAction: () => void
  onResolveProposal?: (approval: ApprovalRequest, resolution: 'approved' | 'rejected') => void
  proposal?: ApprovalRequest
  template: AgentTodoTemplateRecord
}

export const TodoTemplateCard = ({
  isOwner,
  onArchive,
  onEdit,
  onRefuseOwnerAction,
  onResolveProposal,
  proposal,
  template,
}: TodoTemplateCardProps) => {
  const ownerAction = (action: () => void) => {
    if (isOwner) action()
    else onRefuseOwnerAction()
  }

  return (
    <article className="admin-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[color:var(--tx)]">{template.name}</h3>
            <Pill tone={templateStatusTone(template.status)}>{template.status}</Pill>
            {template.authorType === 'agent' ? <Pill tone="warning">proposed by the agent</Pill> : null}
            {proposal?.status === 'rejected' ? <Pill tone="danger">rejected</Pill> : null}
          </div>
          {template.description ? (
            <p className="mt-2 text-sm leading-6 text-[color:var(--tx2)]">{template.description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            className="admin-button admin-button-secondary"
            onClick={() => ownerAction(() => onEdit(template))}
            type="button"
          >
            Edit
          </button>
          {template.status !== 'archived' ? (
            <button
              className="admin-button admin-button-danger"
              onClick={() => ownerAction(() => onArchive(template))}
              type="button"
            >
              Archive
            </button>
          ) : null}
          {proposal?.status === 'pending' && isOwner && onResolveProposal ? (
            <>
              <button className="admin-button admin-button-primary" onClick={() => onResolveProposal(proposal, 'approved')} type="button">Approve</button>
              <button className="admin-button admin-button-secondary" onClick={() => onResolveProposal(proposal, 'rejected')} type="button">Reject</button>
            </>
          ) : null}
        </div>
      </div>
      <ol className="mt-4 grid gap-3">
        {template.steps.map((step, index) => (
          <li className="rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-3" key={step.key}>
            <div className="text-sm font-medium text-[color:var(--tx)]">
              {index + 1}. {step.title}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx2)]">
              {step.instructions}
            </p>
          </li>
        ))}
      </ol>
    </article>
  )
}
