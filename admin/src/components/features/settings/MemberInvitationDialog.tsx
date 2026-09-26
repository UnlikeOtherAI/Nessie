import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
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
import { useToasts } from '../../../providers/ToastProvider'
import { activeTeam } from '../../../lib/teams'
import { invitationSentToast, joinNames, memberAddedToast } from './member-roster-feedback'

type InviteMode = 'existing' | 'workspace'

type MemberInvitationDialogProps = {
  onClose: () => void
  open: boolean
  scope: MemberRosterScope
}

/** One invite dialog for both roster scopes; only teams can add an existing person. */
export const MemberInvitationDialog = ({ onClose, open, scope }: MemberInvitationDialogProps) => {
  const { t, i18n } = useTranslation('settings')
  const { me, token } = useAuthSession()
  const { pushToast } = useToasts()
  const [, setSearchParams] = useSearchParams()
  const invite = useInviteMember(scope)
  const addMember = useAddTeamMember()
  const inviteForm = useFormSubmit(invite.mutateAsync)
  const addCandidateForm = useFormSubmit(addMember.mutateAsync)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [targetIds, setTargetIds] = useState<string[]>([])
  // Names of the teams ticked so far. The team list is paged, so a team chosen
  // on another page is no longer in `targets.items` when the invitation goes
  // out — and the confirmation must name it, not print its id.
  const [targetNames, setTargetNames] = useState<ReadonlyMap<string, string>>(new Map())
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
    setTargetNames(new Map())
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
      setTargetError(t('members.invite.chooseTeam'))
      return
    }
    const address = email.trim()
    const result = await inviteForm.submit({
      email: address,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(scope === 'organization' ? { teamIds: targetIds } : {}),
    })
    if (!result) return
    const nameOf = (id: string) => targetNames.get(id)
      ?? targetItems.find((target) => target.id === id)?.name
      ?? id
    const failedTeamIds = result.failedTeamIds ?? []
    const invitedNames = targetIds.filter((id) => !failedTeamIds.includes(id)).map(nameOf)
    if (failedTeamIds.length === 0) {
      const currentTeam = activeTeam(me)?.label
      pushToast(invitationSentToast(
        address,
        scope === 'organization' ? invitedNames : currentTeam ? [currentTeam] : [],
        i18n.resolvedLanguage ?? i18n.language,
        t,
      ))
      onClose()
      return
    }
    // UOA accepted some teams and refused others (the route answers with an
    // error when it refused all of them). Keep only the refused ones selected
    // so a retry cannot re-send the invitations that went out.
    setTargetIds(failedTeamIds)
    setTargetError(t('members.invite.partialFailure', {
      invited: joinNames(invitedNames, i18n.resolvedLanguage ?? i18n.language),
      failed: joinNames(failedTeamIds.map(nameOf), i18n.resolvedLanguage ?? i18n.language),
    }))
  }

  const targetItems = targets.items
  const allTargetsSelected = targetItems.length > 0
    && targetItems.every((target) => targetIds.includes(target.id))

  const rememberNames = (teams: readonly { id: string; name: string }[]) => {
    setTargetNames((current) => new Map([...current, ...teams.map((team) => [team.id, team.name] as const)]))
  }

  const toggleTarget = (teamId: string, checked: boolean) => {
    setTargetError(null)
    if (checked) rememberNames(targetItems.filter((target) => target.id === teamId))
    setTargetIds((current) => checked
      ? [...current.filter((id) => id !== teamId), teamId]
      : current.filter((id) => id !== teamId))
  }

  const toggleAllTargets = () => {
    const shownIds = new Set(targetItems.map((target) => target.id))
    setTargetError(null)
    if (!allTargetsSelected) rememberNames(targetItems)
    setTargetIds((current) => allTargetsSelected
      ? current.filter((id) => !shownIds.has(id))
      : [...current.filter((id) => !shownIds.has(id)), ...shownIds])
  }

  const addCandidate = async (uoaSub: string, candidateName: string) => {
    const result = await addCandidateForm.submit({ uoaSub })
    if (!result) return
    pushToast(memberAddedToast(candidateName, activeTeam(me)?.label, t))
    onClose()
  }

  const busy = inviteForm.isPending || addCandidateForm.isPending
  const candidateItems = candidates.data?.data.items ?? []

  return (
    <Dialog
      description={t(scope === 'team' ? 'members.invite.teamDescription' : 'members.invite.organizationDescription')}
      dismissDisabled={busy}
      initialFocusRef={scope === 'team' && mode === 'existing' ? undefined : emailRef}
      onClose={onClose}
      open={open}
      title={t('members.invite.title')}
    >
      <div className="space-y-4 p-4">
        {/*
          Rule zero's in-context doorway: inviting people one at a time is
          exactly where "should they just join automatically?" occurs to
          someone, so the answer is offered here rather than only on a tab they
          would have to already know about.
        */}
        {me?.features?.automaticMembership === true ? <p className="text-xs text-[color:var(--tx3)]">
          {t('members.invite.manyPeople')}{' '}
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
            {t('members.invite.setupAutomatic')}
          </button>{' '}
          {t('members.invite.instead')}
        </p> : null}
        {scope === 'team' ? (
          <TabBar
            ariaLabel={t('members.invite.method')}
            idPrefix="member-invite"
            items={[
              { compactLabel: t('members.invite.organization'), label: t('members.invite.fromOrganization'), value: 'existing' },
              { compactLabel: t('members.invite.byEmail'), label: t('members.invite.inviteByEmail'), value: 'workspace' },
            ]}
            onChange={selectMode}
            value={mode}
          />
        ) : null}

        {scope === 'team' && mode === 'existing' ? (
          <div className="space-y-3" id="member-invite-tabpanel-existing" role="tabpanel">
            <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="member-search">
              {t('members.invite.searchOrganization')}
            </label>
            <Input
              autoComplete="off"
              id="member-search"
              onChange={(event) => setCandidateQuery(event.target.value)}
              placeholder={t('members.invite.namePlaceholder')}
              value={candidateQuery}
            />
            {debouncedCandidateQuery.trim() ? <QueryState
              className="py-2"
              emptyLabel={t('members.invite.searchEmpty')}
              errorLabel={t('members.invite.searchFailed')}
              isEmpty={candidateItems.length === 0}
              loadingLabel={t('members.invite.searching')}
              query={candidates}
            >
            {() => (
            <div className="divide-y divide-[color:var(--sep)]">
              {candidateItems.map((candidate) => {
                const candidateName = memberDisplayName(candidate.displayName, candidate.email)
                return (
                  <button
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-[color:var(--main-hover)]"
                    disabled={busy || candidates.data?.data.permissions.addMember !== true}
                    key={candidate.uoaSub}
                    onClick={() => void addCandidate(candidate.uoaSub, candidateName ?? t('members.invite.newMember'))}
                    type="button"
                  >
                    <UserAvatar
                      avatarUrl={candidate.avatarImageUrl}
                      displayName={candidateName ?? t('members.member')}
                      size={32}
                      token={token}
                      uoaSub={candidate.uoaSub}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-[color:var(--tx)]">
                        {candidateName ?? t('members.unnamed')}
                      </span>
                      {candidate.email ? <span className="block truncate text-sm text-[color:var(--tx3)]">{candidate.email}</span> : null}
                    </span>
                  </button>
                )
              })}
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
                    {t('members.invite.teams')}
                    {targetIds.length > 0 ? (
                      <span className="ml-1 font-normal text-[color:var(--tx3)]">({t('members.invite.selected', { count: targetIds.length })})</span>
                    ) : null}
                  </legend>
                  {targetItems.length > 1 ? (
                    <button
                      className="text-xs text-[color:var(--tx2)] underline underline-offset-2 hover:text-[color:var(--tx)] disabled:opacity-50"
                      disabled={busy}
                      onClick={toggleAllTargets}
                      type="button"
                    >
                      {t(allTargetsSelected ? 'members.invite.deselectAll' : 'members.invite.selectAll')}
                    </button>
                  ) : null}
                </div>
                <QueryState className="py-2" emptyLabel={t('members.invite.noTeams')}
                  errorLabel={t('members.invite.teamsLoadFailed')} isEmpty={targetItems.length === 0}
                  loadingLabel={t('members.invite.loadingTeams')} query={targets.query}>
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
              <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="invite-email">{t('members.invite.email')}</label>
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
              <label className="block text-sm font-medium text-[color:var(--tx)]" htmlFor="invite-name">{t('members.invite.nameOptional')}</label>
              <Input id="invite-name" maxLength={120} onChange={(event) => setName(event.target.value)} value={name} />
            </div>
            <FormError>{targetError ?? inviteForm.formError}</FormError>
            <FormActions>
              <button className="admin-button admin-button-secondary" disabled={busy} onClick={onClose} type="button">{t('common.cancel')}</button>
              <button className="admin-button admin-button-primary"
                disabled={busy || (scope === 'organization' && (targets.query.isError
                  || targets.query.data?.data.permissions.createInvitation !== true))}
                type="submit">{inviteForm.isPending ? t('members.invite.sending') : t('members.invite.send')}</button>
            </FormActions>
          </form>
        )}
      </div>
    </Dialog>
  )
}
