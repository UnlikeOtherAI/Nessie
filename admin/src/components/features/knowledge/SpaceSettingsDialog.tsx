import { useEffect, useState, type FormEvent } from 'react'
import { useAgents } from '../../../facades/agents/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { useWorkspaceMembers } from '../../../facades/users/workspace-members'
import { useOptionalAuthSession } from '../../../providers/AuthSessionProvider'
import { Dialog } from '../../shared/Dialog'
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
    writeRestricted?: boolean
  }) => Promise<void>
  open: boolean
  pending?: boolean
  space: KnowledgeSpaceRecord
}

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
  const workspaceMembersQuery = useWorkspaceMembers(open && canManageAccess && isUoaSession)
  const userOptions: KnowledgeMemberOption[] = isUoaSession
    ? (workspaceMembersQuery.data?.members ?? []).flatMap((member) => member.userId
        ? [{
            label: member.displayName ?? member.email ?? 'Workspace member',
            id: member.userId,
          }]
        : [])
    : (usersQuery.data ?? []).map((user) => ({ id: user.id, label: user.displayName }))

  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description ?? '')
  const [memberAgentIds, setMemberAgentIds] = useState<string[]>(space.memberAgentIds)
  const [memberUserIds, setMemberUserIds] = useState<string[]>(space.memberUserIds)
  const [writeRestricted, setWriteRestricted] = useState(space.writeRestricted)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(space.name)
      setDescription(space.description ?? '')
      setMemberAgentIds(space.memberAgentIds)
      setMemberUserIds(space.memberUserIds)
      setWriteRestricted(space.writeRestricted)
      setFormError(null)
    }
  }, [open, space])

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
          ? { memberAgentIds, memberUserIds: effectiveMemberUserIds, writeRestricted }
          : {}),
      })
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save space.')
    }
  }

  return (
    <Dialog onClose={onClose} open={open} title="Space settings">
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="space-settings-name"
          >
            Name
          </label>
          <input
            autoComplete="off"
            className="admin-input"
            id="space-settings-name"
            onChange={(event) => {
              setName(event.target.value)
              setFormError(null)
            }}
            value={name}
          />
          {formError ? (
            <div className="text-xs text-[color:var(--danger-text)]">{formError}</div>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="space-settings-description"
          >
            Description
          </label>
          <textarea
            className="admin-input"
            id="space-settings-description"
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional description"
            rows={3}
            value={description}
          />
        </div>

        {canManageAccess ? (
          <div className="grid gap-3">
            <label className="flex items-start gap-3 text-sm text-[color:var(--tx2)]">
              <input
                checked={writeRestricted}
                className="mt-0.5 accent-[var(--accent)]"
                onChange={(event) => {
                  setWriteRestricted(event.target.checked)
                  if (event.target.checked && me?.user.id) {
                    setMemberUserIds((current) => Array.from(new Set([...current, me.user.id])))
                  }
                }}
                type="checkbox"
              />
              <span>
                <span className="block font-medium text-[color:var(--tx)]">Restrict editing</span>
                <span className="mt-0.5 block text-xs text-[color:var(--tx3)]">
                  Only explicitly added members and the space proprietor can edit; read access is unchanged.
                </span>
              </span>
            </label>
            <div className="grid gap-1.5">
              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--tx3)]">
                People with access
              </span>
              <MemberChecklist
                emptyLabel="No people available."
                members={userOptions}
                onChange={setMemberUserIds}
                selectedIds={memberUserIds}
              />
            </div>
            <div className="grid gap-1.5">
              <span
                className={[
                  'text-xs font-semibold uppercase',
                  'tracking-[0.16em] text-[color:var(--tx3)]',
                ].join(' ')}
              >
                Agents with access
              </span>
              <MemberChecklist
                emptyLabel="No agents available yet."
                members={(agentsQuery.data ?? []).map((agent) => ({ id: agent.id, label: agent.name }))}
                onChange={setMemberAgentIds}
                selectedIds={memberAgentIds}
              />
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
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
        </div>
      </form>
    </Dialog>
  )
}
