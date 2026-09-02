import { useState, type FormEvent } from 'react'
import { useAgents } from '../../../facades/agents/hooks'
import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import { toFormErrors } from '../../../facades/form-errors'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input } from '../../shared/FormControls'
import { MemberChecklist } from './MemberChecklist'

type SpaceVisibility = KnowledgeSpaceRecord['visibility']

type CreateSpaceDialogProps = {
  onClose: () => void
  onCreate: (
    name: string,
    memberAgentIds: string[],
    visibility: SpaceVisibility,
  ) => Promise<void> | void
  open: boolean
  pending?: boolean
}

const VISIBILITY_OPTIONS: { value: SpaceVisibility; label: string; description: string }[] = [
  { value: 'private', label: 'Private', description: 'Only you and people or agents you add' },
  { value: 'channel', label: 'Channel', description: 'Everyone in a channel you pick' },
  { value: 'team', label: 'Team', description: 'Everyone on your team' },
  { value: 'project', label: 'Project', description: 'Everyone on the project' },
  { value: 'organization', label: 'Organization', description: 'Everyone in the organization' },
]

export const CreateSpaceDialog = ({ onClose, onCreate, open, pending }: CreateSpaceDialogProps) => {
  const [name, setName] = useState('')
  const [memberAgentIds, setMemberAgentIds] = useState<string[]>([])
  const [visibility, setVisibility] = useState<SpaceVisibility>('private')
  const [formError, setFormError] = useState<string | undefined>()
  const agentsQuery = useAgents()

  const handleClose = () => {
    setName('')
    setMemberAgentIds([])
    setVisibility('private')
    setFormError(undefined)
    onClose()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    setFormError(undefined)
    try {
      await onCreate(trimmedName, memberAgentIds, visibility)
      handleClose()
    } catch (error) {
      setFormError(toFormErrors(error).formError ?? 'Unable to create space.')
    }
  }

  return (
    <Dialog
      onClose={handleClose}
      open={open}
      title="Create a space"
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <FormField label="Name" required>
          <Input
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Engineering"
            value={name}
          />
        </FormField>

        <ChoiceGroup
          label="Visibility"
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
          value={visibility}
          variant="card"
        />

        <FormField label="Agents">
          <MemberChecklist
            emptyLabel="No agents available yet."
            members={(agentsQuery.data ?? []).map((agent) => ({ id: agent.id, label: agent.name }))}
            onChange={setMemberAgentIds}
            selectedIds={memberAgentIds}
          />
        </FormField>

        <FormError>{formError}</FormError>

        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={handleClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || pending}
            type="submit"
          >
            Create space
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
