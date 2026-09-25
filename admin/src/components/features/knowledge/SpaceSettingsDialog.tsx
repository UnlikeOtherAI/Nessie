import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useAgents } from '../../../facades/agents/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { useTeamMembers } from '../../../facades/users/team-members'
import { useOptionalAuthSession } from '../../../providers/AuthSessionProvider'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { FormField } from '../../shared/FormField'
import { Input, Textarea } from '../../shared/FormControls'
import { SectionLabel } from '../../primitives/SectionLabel'
import { Switch } from '../../primitives/Switch'
import type { KnowledgeSpaceRecord } from '../../../facades/knowledge/hooks'
import {
  MemberChecklist,
  type KnowledgeMemberOption,
} from './MemberChecklist'

type SpaceSettingsDialogProps = {
  canManageAccess: boolean
  onClose: () => void
  onSave: (input: {
    description: string | null
    memberAgentIds?: string[]
    memberUserIds?: string[]
    name: string
    visibility?: KnowledgeSpaceRecord['visibility']
    writeRestricted?: boolean
  }) => Promise<void>
  open: boolean
  pending?: boolean
  space: KnowledgeSpaceRecord
}

const VISIBILITY_OPTIONS: {
  value: KnowledgeSpaceRecord['visibility']
  label: string
  description: string
}[] = [
  { description: 'Only you and people or agents you add', label: 'Private', value: 'private' },
  { description: 'Everyone in a channel you pick', label: 'Channel', value: 'channel' },
  { description: 'Everyone on your team', label: 'Team', value: 'team' },
  { description: 'Everyone on the project', label: 'Project', value: 'project' },
  { description: 'Everyone in the organization', label: 'Organization', value: 'organization' },
]

// The API supplies the access-administration entitlement independently of the
// ordinary content-write verdict. A writer may still edit the descriptive
// fields without gaining control of restriction or membership.
export const SpaceSettingsDialog = ({
  canManageAccess,
  onClose,
  onSave,
  open,
  pending,
  space,
}: SpaceSettingsDialogProps) => {
  const me = useOptionalAuthSession()?.me ?? null
  const isUoaSession = me?.auth.providerType === 'uoa'
  const agentsQuery = useAgents()
  const usersQuery = useUsers(open && canManageAccess && !isUoaSession)
  const teamMembersQuery = useTeamMembers(open && canManageAccess && isUoaSession)
  const userOptions: KnowledgeMemberOption[] = isUoaSession
    ? (teamMembersQuery.data?.members ?? []).flatMap((member) => member.userId
        ? [{
            label: member.displayName ?? member.email ?? 'Team member',
            id: member.userId,
          }]
        : [])
    : (usersQuery.data ?? []).map((user) => ({ id: user.id, label: user.displayName }))

  // Depend on the actual form values, not the query wrapper's object identity.
  // Agent/user directory updates can re-render this dialog; resetting from a
  // freshly allocated but unchanged `space` object made the first checkbox
  // click visibly flash and then disappear.
  const memberAgentKey = space.memberAgentIds.join('\u0000')
  const memberUserKey = space.memberUserIds.join('\u0000')
  const initialForm = useMemo(() => ({
    description: space.description ?? '',
    memberAgentIds: memberAgentKey ? memberAgentKey.split('\u0000') : [],
    memberUserIds: memberUserKey ? memberUserKey.split('\u0000') : [],
    name: space.name,
    visibility: space.visibility,
    writeRestricted: space.writeRestricted,
  }), [
    space.description,
    memberAgentKey,
    memberUserKey,
    space.name,
    space.visibility,
    space.writeRestricted,
  ])

  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [memberAgentIds, setMemberAgentIds] = useState<string[]>(space.memberAgentIds)
  const [memberUserIds, setMemberUserIds] = useState<string[]>(space.memberUserIds)
  const [writeRestricted, setWriteRestricted] = useState(space.writeRestricted)
  const [visibility, setVisibility] = useState<KnowledgeSpaceRecord['visibility']>(space.visibility)
  const [formError, setFormError] = useState<string | undefined>()

  useEffect(() => {
    if (open) {
      setName(initialForm.name)
      setDescription(initialForm.description)
      setMemberAgentIds(initialForm.memberAgentIds)
      setMemberUserIds(initialForm.memberUserIds)
      setWriteRestricted(initialForm.writeRestricted)
      setVisibility(initialForm.visibility)
      setFormError(undefined)
    }
  }, [initialForm, open])

  if (!open) return null

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmedName = name.trim()
    if (!trimmedName) return
    try {
      const effectiveMemberUserIds = writeRestricted && me?.user.id
        ? Array.from(new Set([...memberUserIds, me.user.id]))
        : memberUserIds
      await onSave({
        name: trimmedName,
        description: description.trim() ? description.trim() : null,
        ...(canManageAccess
          ? { memberAgentIds, memberUserIds: effectiveMemberUserIds, visibility, writeRestricted }
          : {}),
      })
    } catch (error) {
      setFormError(toFormErrors(error).formError ?? 'Unable to save space.')
    }
  }

  return (
    <Dialog onClose={onClose} open={open} title="Space settings">
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <FormField label="Name" required>
          <Input
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value)
              setFormError(undefined)
            }}
            value={name}
          />
        </FormField>

        <FormField label="Description">
          <Textarea
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional description"
            rows={3}
            value={description}
          />
        </FormField>

        {canManageAccess ? (
          <div className="grid gap-3">
            {/* Who the folder is *for*, which is the first question about it
                and, until now, the one this dialog could not answer: the value
                could be chosen at creation and never changed again, so a
                folder created private stayed private with no way back. */}
            <ChoiceGroup
              label="Visibility"
              onChange={setVisibility}
              options={VISIBILITY_OPTIONS}
              value={visibility}
              variant="card"
            />
            <div className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-medium text-[color:var(--tx)]">Restrict editing</span>
                <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">
                  Only explicitly added members and the space proprietor can edit; read access is unchanged.
                </span>
              </span>
              <Switch
                checked={writeRestricted}
                label="Restrict editing"
                onChange={(checked) => {
                  setWriteRestricted(checked)
                  if (checked && me?.user.id) {
                    setMemberUserIds((current) => Array.from(new Set([...current, me.user.id])))
                  }
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <SectionLabel size="sm">People with access</SectionLabel>
              <MemberChecklist
                emptyLabel="No people available."
                members={userOptions}
                onChange={setMemberUserIds}
                selectedIds={memberUserIds}
              />
            </div>
            <div className="grid gap-1.5">
              <SectionLabel size="sm">Agents with access</SectionLabel>
              <MemberChecklist
                emptyLabel="No agents available yet."
                members={(agentsQuery.data ?? []).map((agent) => ({
                  agentVisibility: agent.visibility,
                  id: agent.id,
                  label: agent.name,
                }))}
                onChange={setMemberAgentIds}
                selectedIds={memberAgentIds}
              />
            </div>
          </div>
        ) : null}

        <FormError>{formError}</FormError>

        <FormActions>
          <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!name.trim() || pending}
            type="submit"
          >
            Save
          </button>
        </FormActions>
      </form>
    </Dialog>
  )
}
