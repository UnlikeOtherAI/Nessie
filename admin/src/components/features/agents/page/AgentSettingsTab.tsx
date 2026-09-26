import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useDeleteAgent } from '../../../../facades/agents/mutations'
import { useIsOwner } from '../../../../facades/auth/hooks'
import { formErrorMessage } from '../../../../facades/forms/form-errors'
import { useCurrentOrganization } from '../../../../facades/organization/hooks'
import type { AgentRecord } from '../../../../lib/api-client'
import { ConfirmDialog } from '../../../shared/ConfirmDialog'
import { PageBody, Section } from '../../../shared/PageBody'
import { AgentOwnershipState } from '../AgentOwnershipState'
import {
  AgentModelFields,
  AgentNameRoleFields,
  AgentTodosSetting,
  AgentVisibilityField,
} from './AgentConfigFields'
import { BuiltInAgentNote } from './BuiltInAgentNote'
import type { AgentConfigForm } from './useAgentConfigForm'

type AgentSettingsTabProps = {
  agent: AgentRecord
  builtIn: boolean
  canEdit: boolean
  form: AgentConfigForm
}

const linkClass = 'text-[color:var(--lnk)] hover:underline'

/** Where a missing model is decided, said to the person who can decide it. */
const ModelDoorways = () => {
  const organization = useCurrentOrganization()
  const canManageModels = organization.data?.administration.status === 'allowed'
  return (
    <p className="text-xs leading-5 text-[color:var(--tx3)]">
      To run it on an AI plan you pay for, link the plan in{' '}
      <Link className={linkClass} to="/settings/accounts?tab=ai">Connected accounts</Link>.{' '}
      {canManageModels ? (
        <>Which models the organisation offers is chosen in <Link className={linkClass} to="/admin/models">AI models</Link>.</>
      ) : (
        'Missing a model? Ask an organisation administrator to turn it on.'
      )}
    </p>
  )
}

const DeleteAgent = ({ agent }: { agent: AgentRecord }) => {
  const navigate = useNavigate()
  const deleteAgent = useDeleteAgent()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <div>
        <button
          className="admin-button admin-button-secondary admin-button-danger"
          data-testid="agent-delete"
          onClick={() => {
            setError(null)
            setOpen(true)
          }}
          type="button"
        >
          Delete agent
        </button>
      </div>
      <ConfirmDialog
        body={
          <div className="grid gap-2">
            <p>
              {`${agent.name} will stop working: it is removed from every channel it was placed in, `
                + 'its schedules are deleted, and any run it has in flight is cancelled. '
                + 'Its past work stays in the record.'}
            </p>
            {error ? <p className="text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
          </div>
        }
        confirmLabel="Delete agent"
        destructive
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          deleteAgent.mutate(agent.id, {
            // The server is the authority; its refusal belongs on the dialog.
            onError: (cause) => setError(formErrorMessage(cause, 'Unable to delete this agent.')),
            onSuccess: () => void navigate('/admin/agents', { replace: true }),
          })
        }}
        open={open}
        pending={deleteAgent.isPending}
        title={`Delete ${agent.name}?`}
      />
    </>
  )
}

/**
 * Settings: how the agent is set up — its name and role, its visibility
 * (chosen once), its model with the doorways to a plan or an administrator,
 * effort and run limits, voice, to-dos, who owns it, and deleting it. The
 * form fields save with Instructions through the page's one Save.
 */
export const AgentSettingsTab = ({ agent, builtIn, canEdit, form }: AgentSettingsTabProps) => {
  const isOwner = useIsOwner()
  const readOnly = builtIn || !canEdit
  return (
    <PageBody>
      {builtIn ? <BuiltInAgentNote /> : null}
      <Section title="Name and role">
        <AgentNameRoleFields form={form} readOnly={readOnly} />
      </Section>
      <Section title="Visibility">
        <AgentVisibilityField form={form} readOnly />
      </Section>
      <Section title="Model and limits">
        <AgentModelFields agentId={agent.id} form={form} readOnly={readOnly} />
        {readOnly ? null : <ModelDoorways />}
      </Section>
      {builtIn ? null : (
        <Section title="To-dos">
          <AgentTodosSetting canManageTodos={isOwner} form={form} readOnly={readOnly} />
        </Section>
      )}
      {builtIn ? null : (
        <Section title="Ownership">
          <AgentOwnershipState agent={agent} />
        </Section>
      )}
      {canEdit && !builtIn ? (
        <Section title="Delete this agent">
          <DeleteAgent agent={agent} />
        </Section>
      ) : null}
    </PageBody>
  )
}
