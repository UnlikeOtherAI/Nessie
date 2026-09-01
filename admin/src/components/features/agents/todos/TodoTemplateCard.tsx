import type { AgentTodoTemplateRecord } from '@nessie/schemas'

import { Pill } from '../../../primitives/Pill'
import { ExpandableTable } from '../../../shared/ExpandableTable'
import type { ApprovalRequest } from '../../../../facades/approvals/hooks'
import { templateStatusTone } from './todo-presentation'
import { ScheduledTodoTemplate } from './ScheduledTodoTemplate'
import type { AgentRecord, AgentTriggerRecord, ChannelRecord } from '../../../../lib/api-client'

type TodoTemplateCardProps = {
  isOwner: boolean
  agent: AgentRecord
  channels: ChannelRecord[]
  onArchive: (template: AgentTodoTemplateRecord) => void
  onEdit: (template: AgentTodoTemplateRecord) => void
  onRefuseOwnerAction: () => void
  onResolveProposal?: (approval: ApprovalRequest, resolution: 'approved' | 'rejected') => void
  proposal?: ApprovalRequest
  template: AgentTodoTemplateRecord
  trigger?: AgentTriggerRecord
}

/**
 * One template as a dense table, matching the instance rows: a summary line,
 * then one row per step with its instructions as a clamped second line. The
 * full text stays reachable through the row's title attribute and the editor.
 */
export const TodoTemplateCard = ({
  isOwner,
  agent,
  channels,
  onArchive,
  onEdit,
  onRefuseOwnerAction,
  onResolveProposal,
  proposal,
  template,
  trigger,
}: TodoTemplateCardProps) => {
  const ownerAction = (action: () => void) => {
    if (isOwner) action()
    else onRefuseOwnerAction()
  }

  return (
    <article className="admin-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5">
        <h3 className="truncate text-sm font-semibold text-[color:var(--tx)]">{template.name}</h3>
        <Pill size="sm" tone={templateStatusTone(template.status)}>{template.status}</Pill>
        {template.authorType === 'agent' ? (
          <Pill size="sm" tone="warning">proposed by the agent</Pill>
        ) : null}
        {proposal?.status === 'rejected' ? <Pill size="sm" tone="danger">rejected</Pill> : null}
        <span className="truncate text-xs text-[color:var(--tx3)]" title={template.description ?? ''}>
          {template.steps.length} {template.steps.length === 1 ? 'step' : 'steps'}
          {template.description ? ` · ${template.description}` : ''}
        </span>
        <div className="ml-auto flex shrink-0 gap-2">
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
              <button
                className="admin-button admin-button-primary"
                onClick={() => onResolveProposal(proposal, 'approved')}
                type="button"
              >
                Approve
              </button>
              <button
                className="admin-button admin-button-secondary"
                onClick={() => onResolveProposal(proposal, 'rejected')}
                type="button"
              >
                Reject
              </button>
            </>
          ) : null}
        </div>
      </div>

      <ExpandableTable label={`Steps for ${template.name}`}>
        <table className="admin-table w-full border-collapse border-t border-[color:var(--sep)]">
          <tbody>
            {template.steps.map((step, index) => (
              <tr className="border-t border-[color:var(--sep)]" key={step.key}>
                <td className="w-8 py-2 pl-4 pr-0 align-top text-xs text-[color:var(--tx3)]">
                  {index + 1}
                </td>
                <td className="min-w-0 px-2 py-2 pr-4">
                  <div className="truncate text-sm font-medium text-[color:var(--tx)]" title={step.title}>
                    {step.title}
                  </div>
                  <div className="truncate text-xs leading-5 text-[color:var(--tx2)]" title={step.instructions}>
                    {step.instructions}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ExpandableTable>

      {template.status === 'active' && isOwner ? (
        <div className="border-t border-[color:var(--sep)] px-4 py-2.5">
          <ScheduledTodoTemplate agent={agent} channels={channels} templateId={template.id} trigger={trigger} />
        </div>
      ) : null}
    </article>
  )
}
