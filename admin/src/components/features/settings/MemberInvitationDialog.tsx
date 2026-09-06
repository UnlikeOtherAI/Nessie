import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'

import { TabBar } from '../../primitives/TabBar'
import { UserAvatar } from '../../shared/UserAvatar'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { Input, Select } from '../../shared/FormControls'
import { PaginationFooter } from '../../shared/PaginationFooter'
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
  const { token } = useAuthSession()
  const [, setSearchParams] = useSearchParams()
  const invite = useInviteMember(scope)
  const addMember = useAddTeamMember()
  const inviteForm = useFormSubmit(invite.mutateAsync)
  const addCandidateForm = useFormSubmit(addMember.mutateAsync)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState('')
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

  useEffect(() => {
    if (!open) return
    setTargetError(null)
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
    if (scope === 'organization' && !targetId) {
      setTargetError('Choose the workspace receiving this invitation.')
      return
    }
    const result = await inviteForm.submit({
      email: email.trim(),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(scope === 'organization' ? { teamId: targetId } : {}),
    })
    if (result) onClose()
  }

  const addCandidate = async (uoaSub: string) => {
    const result = await addCandidateForm.submit({ uoaSub })
    if (result) onClose()
  }

  const busy = inviteForm.isPending || addCandidateForm.isPending
  const targetItems = targets.items
  const candidateItems = candidates.data?.data.items ?? []

  return (
    <Dialog
      description={scope === 'team'
        ? 'Add an existing organisation member or send a workspace invitation.'
        : 'Choose the workspace that will receive the invitation.'}
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
        <p className="text-xs text-[color:var(--tx3)]">
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
        </p>
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
            {candidateQuery.trim() && candidates.isLoading ? (
              <p className="text-sm text-[color:var(--tx3)]">Searching members…</p>
            ) : null}
            {candidateQuery.trim() && !candidates.isLoading && candidateItems.length === 0 ? (
              <p className="text-sm text-[color:var(--tx3)]">No eligible members found.</p>
            ) : null}
            <div className="divide-y divide-[color:var(--sep)]">
              {candidateItems.map((candidate) => (
                <button
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-[color:var(--main-hover)]"
                  disabled={busy}
                  key={candidate.uoaSub}
                  onClick={() => void addCandidate(candidate.uoaSub)}
                  type="button"
                >
                  <UserAvatar
                    avatarUrl={candidate.avatarImageUrl}
                    displayName={candidate.displayName ?? candidate.email ?? 'Member'}
                    size={32}
                    token={token}
                    uoaSub={candidate.uoaSub}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-[color:var(--tx)]">
                      {candidate.displayName ?? candidate.email ?? 'Unnamed member'}
                    </span>
                    {candidate.email ? <span className="block truncate text-sm text-[color:var(--tx3)]">{candidate.email}</span> : null}
                  </span>
                </button>
              ))}
            </div>
            <FormError>{addCandidateForm.formError}</FormError>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(event) => void submitInvite(event)}>
            {scope === 'organization' ? (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="invite-team">
                  Workspace
                </label>
                <Select id="invite-team" onChange={(event) => setTargetId(event.target.value)} value={targetId}>
                  <option value="">Choose a workspace</option>
                  {targetItems.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </Select>
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
              </div>
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
              <Input id="invite-name" onChange={(event) => setName(event.target.value)} value={name} />
            </div>
            <FormError>{targetError ?? inviteForm.formError}</FormError>
            <FormActions>
              <button className="admin-button admin-button-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
              <button className="admin-button admin-button-primary" disabled={busy} type="submit">Send invitation</button>
            </FormActions>
          </form>
        )}
      </div>
    </Dialog>
  )
}
