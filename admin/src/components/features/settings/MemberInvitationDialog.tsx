import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Checkbox } from '../../primitives/Checkbox'
import { TabBar } from '../../primitives/TabBar'
import { UserAvatar } from '../../shared/UserAvatar'
import { memberDisplayName } from '../../../lib/member-display-name'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { Input } from '../../shared/FormControls'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { QueryState } from '../../shared/QueryState'
import { useFormSubmit } from '../../../facades/forms/form-errors'
import {
  useAddTeamMember,
  useInvitationTargets,
  useInviteMember,
  useTeamMemberCandidates,
  type MemberRosterScope,
} from '../../../facades/users/member-roster'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

type InviteMode = 'existing' | 'workspace'

type MemberInvitationDialogProps = {
  onClose: () => void
  open: boolean
  scope: MemberRosterScope
}

/** One invite dialog for both roster scopes; only teams can add an existing person. */
export const MemberInvitationDialog = ({ onClose, open, scope }: MemberInvitationDialogProps) => {
  const { me, token } = useAuthSession()
  const [, setSearchParams] = useSearchParams()
  const invite = useInviteMember(scope)
  const addMember = useAddTeamMember()
  const inviteForm = useFormSubmit(invite.mutateAsync)
  const addCandidateForm = useFormSubmit(addMember.mutateAsync)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [targetError, setTargetError] = useState<string | null>(null)
  const [candidateQuery, setCandidateQuery] = useState('')
  const [debouncedCandidateQuery, setDebouncedCandidateQuery] = useState('')
  // This selects a branch of one transient form. It resets when the dialog
  // closes; a URL parameter would outlive the dialog and collide with the page.
  const [mode, setMode] = useState<InviteMode>('existing')
  const emailRef = useRef<HTMLInputElement | null>(null)
  const targets = useInvitationTargets(open && scope === 'organization')
  const candidates = useTeamMemberCandidates(
    debouncedCandidateQuery,
    open && scope === 'team',
  )

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedCandidateQuery(candidateQuery), 200)
    return () => window.clearTimeout(timer)
  }, [candidateQuery])

  const resetInviteForm = inviteForm.reset
  const resetAddCandidateForm = addCandidateForm.reset

  // Reset when the dialog closes, not when it opens: an effect runs after the
  // opened dialog paints, so resetting then could discard a choice already made.
  useEffect(() => {
    if (open) return
    setTargetError(null)
    setEmail('')
    setName('')
    setTargetIds([])
    resetInviteForm()
    resetAddCandidateForm()
    setCandidateQuery('')
    setDebouncedCandidateQuery('')
    setMode('existing')
  }, [open, resetAddCandidateForm, resetInviteForm])

  const selectMode = (next: InviteMode) => setMode(next)

  const submitInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setTargetError(null)
    if (scope === 'organization' && targetIds.length === 0) {
      setTargetError('Choose at least one workspace for this invitation.')
      return
    }
    const result = await inviteForm.submit({
      email: email.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(scope === 'organization' ? { teamIds: targetIds } : {}),
    })
    if (!result) return
    const failedTeamIds = result.failedTeamIds ?? []
    if (failedTeamIds.length === 0) {
      onClose()
      return
    }
    // UOA accepted some workspaces and refused others. Keep only the refused
    // ones selected so a retry cannot re-send the invitations that went out.
    const nameOf = (id: string) => targetItems.find((target) => target.id === id)?.name ?? id
    setTargetIds(failedTeamIds)
    setTargetError(`The invitation could not be sent to ${failedTeamIds.map(nameOf).join(', ')}. `
      + 'The other selected workspaces received it.')
  }

  const targetItems = targets.items
  const allTargetsSelected = targetItems.length > 0
    && targetItems.every((target) => targetIds.includes(target.id))

  const toggleTarget = (teamId: string, checked: boolean) => {
    setTargetError(null)
    setTargetIds((current) => checked
      ? [...current.filter((id) => id !== teamId), teamId]
      : current.filter((id) => id !== teamId))
  }

  const toggleAllTargets = () => {
    const shownIds = new Set(targetItems.map((target) => target.id))
    setTargetError(null)
    setTargetIds((current) => allTargetsSelected
      ? current.filter((id) => !shownIds.has(id))
      : [...current.filter((id) => !shownIds.has(id)), ...shownIds])
  }

  const addCandidate = async (uoaSub: string) => {
    const result = await addCandidateForm.submit({ uoaSub })
    if (result) onClose()
  }

  const busy = inviteForm.isPending || addCandidateForm.isPending
  const candidateItems = candidates.data?.data.items ?? []

  return (
    <Dialog
      description={scope === 'team'
        ? 'Add an existing organisation member or send a workspace invitation.'
        : 'Choose the workspaces that will receive the invitation.'}
      dismissDisabled={busy}
      initialFocusRef={scope === 'team' && mode === 'existing' ? undefined : emailRef}
      onClose={onClose}
      open={open}
      title="Invite member"
    >
      <div className="space-y-4 p-4">
        {/*
          Rule zero's in-context doorway: inviting people one at a time is
          exactly where "should they just join automatically?" occurs to
          someone, so the answer is offered here rather than only on a tab they
          would have to already know about.
        */}
        {me?.features?.automaticMembership === true ? <p className="text-xs text-[color:var(--tx3)]">
          Adding lots of people from one company?{' '}
          <button
            className="underline underline-offset-2"
            onClick={() => {
              onClose()
              setSearchParams((current) => {
                const updated = new URLSearchParams(current)
                updated.set('membersTab', 'automatic')
                return updated
              }, { replace: true })
            }}
            type="button"
          >
            Set up automatic team access
          </button>{' '}
          instead.
        </p> : null}
        {scope === 'team' ? (
          <TabBar
            ariaLabel="Invitation method"
            idPrefix="member-invite"
            items={[
              { label: 'Existing user', value: 'existing' },
              { label: 'Invite to workspace', value: 'workspace' },
            ]}
            onChange={selectMode}
            value={mode}
          />
        ) : null}

        {scope === 'team' && mode === 'existing' ? (
          <div className="space-y-3" id="member-invite-tabpanel-existing" role="tabpanel">
            <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="member-search">
              Search organisation members
            </label>
            <Input
              autoComplete="off"
              id="member-search"
              onChange={(event) => setCandidateQuery(event.target.value)}
              placeholder="Start typing a name"
              value={candidateQuery}
            />
            {debouncedCandidateQuery.trim() ? <QueryState
              className="py-2"
              emptyLabel="No eligible members found."
              errorLabel="Members could not be searched."
              isEmpty={candidateItems.length === 0}
              loadingLabel="Searching members…"
              query={candidates}
            >
            {() => (
            <div className="divide-y divide-[color:var(--sep)]">
              {candidateItems.map((candidate) => (
                <button
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-[color:var(--main-hover)]"
                  disabled={busy || candidates.data?.data.permissions.addMember !== true}
                  key={candidate.uoaSub}
                  onClick={() => void addCandidate(candidate.uoaSub)}
                  type="button"
                >
                  <UserAvatar
                    avatarUrl={candidate.avatarImageUrl}
                    displayName={memberDisplayName(candidate.displayName, candidate.email) ?? 'Member'}
                    size={32}
                    token={token}
                    uoaSub={candidate.uoaSub}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-[color:var(--tx)]">
                      {memberDisplayName(candidate.displayName, candidate.email) ?? 'Unnamed member'}
                    </span>
                    {candidate.email ? <span className="block truncate text-sm text-[color:var(--tx3)]">{candidate.email}</span> : null}
                  </span>
                </button>
              ))}
            </div>
            )}
            </QueryState> : null}
            <FormError>{addCandidateForm.formError}</FormError>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => void submitInvite(event)}>
            {scope === 'organization' ? (
              <fieldset className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <legend className="text-sm font-medium text-[color:var(--tx)]">
                    Workspaces
                    {targetIds.length > 0 ? (
                      <span className="ml-1 font-normal text-[color:var(--tx3)]">({targetIds.length} selected)</span>
                    ) : null}
                  </legend>
                  {targetItems.length > 1 ? (
                    <button
                      className="text-xs text-[color:var(--tx2)] underline underline-offset-2 hover:text-[color:var(--tx)] disabled:opacity-50"
                      disabled={busy}
                      onClick={toggleAllTargets}
                      type="button"
                    >
                      {allTargetsSelected ? 'Deselect all' : 'Select all'}
                    </button>
                  ) : null}
                </div>
                <QueryState className="py-2" emptyLabel="There are no workspaces you can invite people to."
                  errorLabel="Teams could not be loaded." isEmpty={targetItems.length === 0}
                  loadingLabel="Loading teams…" query={targets.query}>
                {() => <div className="grid max-h-64 gap-1 overflow-y-auto">
                  {targetItems.map((target) => (
                    <div className="rounded px-1.5 py-1 hover:bg-[color:var(--overlay)]" key={target.id}>
                      <Checkbox
                        checked={targetIds.includes(target.id)}
                        disabled={busy}
                        label={target.name}
                        onChange={(checked) => toggleTarget(target.id, checked)}
                      />
                    </div>
                  ))}
                </div>}
                </QueryState>
                <PaginationFooter
                  canNext={targets.canNext}
                  canPrevious={targets.canPrevious}
                  hideWhenSinglePage
                  label={targets.label}
                  onPageChange={targets.onPageChange}
                  onPageSizeChange={targets.onPageSizeChange}
                  page={targets.page}
                  pageCount={targets.pageCount}
                  pageSize={targets.pageSize}
                />
              </fieldset>
            ) : null}
            <div className="space-y-2">
              <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="invite-email">Email</label>
              <Input
                autoComplete="email"
                id="invite-email"
                onChange={(event) => setEmail(event.target.value)}
                ref={emailRef}
                required
                type="email"
                value={email}
              />
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="invite-name">Name (optional)</label>
              <Input id="invite-name" maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
            </div>
            <FormError>{targetError ?? inviteForm.formError}</FormError>
            <FormActions>
              <button className="admin-button admin-button-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
              <button className="admin-button admin-button-primary"
                disabled={busy || (scope === 'organization' && (targets.query.isError
                  || targets.query.data?.data.permissions.createInvitation !== true))}
                type="submit">Send invitation</button>
            </FormActions>
          </form>
        )}
      </div>
    </Dialog>
  )
}
