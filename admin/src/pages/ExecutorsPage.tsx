import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type {
  ExecutorCreateResponse,
  PreparedExecutorAccessChangeResponse,
} from '@nessie/schemas'
import { ExecutorCreatePanel } from '../components/features/executors/ExecutorCreatePanel'
import { ExecutorDesktopCompanionPanel } from '../components/features/executors/ExecutorDesktopCompanionPanel'
import { ExecutorDetailPanels } from '../components/features/executors/ExecutorDetailPanels'
import { ExecutorWorkspacePromotionsPanel } from '../components/features/executors/ExecutorWorkspacePromotionsPanel'
import { FormError } from '../components/shared/FormActions'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { useAgents } from '../facades/agents/hooks'
import {
  useConfirmExecutorAccessChange,
  useConfirmExecutorEnrollment,
  useConfirmExecutorWorkspacePromotion,
  useExecutorAccess,
  useExecutorAccessChange,
  useExecutorWorkspacePromotion,
  useExecutorWorkspaceReviews,
  useExecutors,
  useMyExecutorWorkspaceReviews,
  usePendingExecutorEnrollment,
  usePrepareExecutorWorkspacePromotion,
  useRejectExecutorAccessChange,
  useRejectExecutorWorkspacePromotion,
} from '../facades/executors/hooks'
import { useProjects } from '../facades/projects/hooks'
import { useUsers } from '../facades/users/hooks'
import { getBaseUrl } from '../lib/api-client'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { LOCAL_BACK_PRIORITY } from '../layouts/admin-shell/local-back/LocalBackContext'
import { NestedStage } from '../navigation/NestedStage'
import { parseHashParam, useConsumedHashIntent, useConsumedIntents } from '../navigation/intent'

const statusClass = (status: string): string => status === 'online'
  ? 'text-[color:var(--success-text)]'
  : status === 'pending_pairing' || status === 'draining'
    ? 'text-[color:var(--warning-text)]'
    : status === 'revoked' || status === 'error'
      ? 'text-[color:var(--danger-text)]'
      : 'text-[color:var(--tx3)]'

// A project's "add executor" doorway (`?create=project&scopeProjectId=`) and
// a Personal Assistant review link (`#confirmationToken=`) are one-shot
// intents the registry declares for this route (docs/navigation/overview.md §8): both
// are captured once and stripped, so the token never survives in history or
// a shared address. A token this page mints itself lives in state only.
const CREATE_INTENTS = ['create', 'scopeProjectId'] as const
const parseConfirmationToken = parseHashParam('confirmationToken')

export const ExecutorsPage = () => {
  const { me } = useAuthSession()
  const [searchParams, setSearchParams] = useSearchParams()
  const createIntent = useConsumedIntents(CREATE_INTENTS)
  const fixedProjectId = createIntent.values.create === 'project'
    ? createIntent.values.scopeProjectId ?? undefined
    : undefined
  const [showCreate, setShowCreate] = useState(false)
  const [created, setCreated] = useState<ExecutorCreateResponse | null>(null)
  const linkedToken = useConsumedHashIntent('confirmationToken', parseConfirmationToken)
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [reviewError, setReviewError] = useState<string | null>(null)
  const executorsQuery = useExecutors()
  const agentsQuery = useAgents()
  const usersQuery = useUsers()
  const projectsQuery = useProjects()
  const executors = executorsQuery.data ?? []
  const selectedId = searchParams.get('executorId') ?? created?.executor.id ?? executors[0]?.id
  const selected = executors.find((executor) => executor.id === selectedId) ?? created?.executor
  const accessQuery = useExecutorAccess(selected?.id)
  const reviewsQuery = useExecutorWorkspaceReviews(selected?.id)
  const myReviewsQuery = useMyExecutorWorkspaceReviews()
  const changeId = searchParams.get('accessChange') ?? undefined
  const changeQuery = useExecutorAccessChange(changeId)
  const promotionId = searchParams.get('promotion') ?? undefined
  const promotionQuery = useExecutorWorkspacePromotion(promotionId)
  const pendingPairing = usePendingExecutorEnrollment(selected?.id)
  const confirmPairing = useConfirmExecutorEnrollment()
  const confirmChange = useConfirmExecutorAccessChange()
  const rejectChange = useRejectExecutorAccessChange()
  const preparePromotion = usePrepareExecutorWorkspacePromotion()
  const confirmPromotion = useConfirmExecutorWorkspacePromotion()
  const rejectPromotion = useRejectExecutorWorkspacePromotion()

  useEffect(() => {
    if (fixedProjectId) setShowCreate(true)
  }, [createIntent.serial, fixedProjectId])
  useEffect(() => {
    if (linkedToken.value) setConfirmationToken(linkedToken.value)
  }, [linkedToken])

  const reviewChange = changeQuery.data
  const promotionChange = promotionQuery.data
  const setSelection = (executorId: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('executorId', executorId)
    next.delete('accessChange')
    next.delete('promotion')
    setSearchParams(next, { replace: true })
    setConfirmationToken(null)
  }
  const openReview = (prepared: PreparedExecutorAccessChangeResponse) => {
    const next = new URLSearchParams(searchParams)
    next.set('accessChange', prepared.accessChangeId)
    next.set('executorId', prepared.executorId)
    next.delete('promotion')
    setSearchParams(next, { replace: true })
    setConfirmationToken(prepared.confirmationToken)
  }
  const clearReview = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('accessChange')
    next.delete('promotion')
    setSearchParams(next, { replace: true })
    setConfirmationToken(null)
    setCurrentPassword('')
  }
  const openPromotion = (prepared: {
    confirmationToken: string
    executorId: string
    promotionId: string
  }) => {
    const next = new URLSearchParams(searchParams)
    next.delete('accessChange')
    next.set('executorId', prepared.executorId)
    next.set('promotion', prepared.promotionId)
    setSearchParams(next, { replace: true })
    setConfirmationToken(prepared.confirmationToken)
  }
  const handleCreated = (result: ExecutorCreateResponse) => {
    setCreated(result)
    setShowCreate(false)
    setSelection(result.executor.id)
  }
  const handleConfirmChange = async () => {
    if (!reviewChange || !confirmationToken) return
    setReviewError(null)
    try {
      await confirmChange.mutateAsync({
        accessChangeId: reviewChange.accessChangeId,
        confirmationToken,
        ...(reviewChange.requiresFreshVerification ? { currentPassword } : {}),
      })
      clearReview()
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Unable to confirm access change.')
    }
  }
  const handleRejectChange = async () => {
    if (!reviewChange || !confirmationToken) return
    setReviewError(null)
    try {
      await rejectChange.mutateAsync({
        accessChangeId: reviewChange.accessChangeId,
        confirmationToken,
      })
      clearReview()
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Unable to reject access change.')
    }
  }
  const handlePreparePromotion = async (reviewCommandId: string) => {
    setReviewError(null)
    try {
      openPromotion(await preparePromotion.mutateAsync({ reviewCommandId }))
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Unable to prepare workspace promotion.')
    }
  }
  const handleConfirmPromotion = async () => {
    if (!promotionChange || !confirmationToken) return
    setReviewError(null)
    try {
      await confirmPromotion.mutateAsync({
        confirmationToken,
        currentPassword,
        promotionId: promotionChange.promotionId,
      })
      clearReview()
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Unable to promote workspace draft.')
    }
  }
  const handleRejectPromotion = async () => {
    if (!promotionChange || !confirmationToken) return
    setReviewError(null)
    try {
      await rejectPromotion.mutateAsync({ confirmationToken, promotionId: promotionChange.promotionId })
      clearReview()
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : 'Unable to reject workspace promotion.')
    }
  }

  const pairingCommand = useMemo(() => created
    ? `nessie-executor pair --api ${getBaseUrl() || 'https://api.nessie.works'} --state-dir "$HOME/.nessie-executor" --workspace "/absolute/read-only/workspace" --enrollment ${created.invitation.enrollmentId} --challenge ${created.invitation.challenge}`
    : null, [created])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The hero's eyebrow, title and paragraph are the one header's
          eyebrow, title and subtitle; its two buttons are measured actions
          that fold into More rather than wrapping into a ragged row. */}
      <ScreenHeader
        actions={[
          {
            href: '/apps',
            id: 'manage-apps',
            kind: 'link',
            label: 'Manage apps',
            priority: 40,
          },
          {
            id: 'pair-executor',
            label: showCreate ? 'Close pairing' : 'Pair executor',
            onSelect: () => setShowCreate((open) => !open),
            // Primary while it opens the pairing form; closing that form again
            // is not the action this screen exists for.
            primary: !showCreate,
            priority: 100,
          },
        ]}
        eyebrow="Agents"
        subtitle={
          <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
            Pair governed sandboxes and coding sessions. Executors are separate from connectors:
            connectors provide remote services; executors run approved work on a paired machine or guest runtime.
          </p>
        }
        title="Executors"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-5 px-[var(--page-gutter)] py-6">

        <NestedStage
          active={showCreate && Boolean(me)}
          id="executors:create"
          label="Back to executors"
          onBack={() => setShowCreate(false)}
          priority={LOCAL_BACK_PRIORITY.executorsCreate}
          title="New executor"
        >
          {me ? (
            <ExecutorCreatePanel
              agents={agentsQuery.data ?? []}
              currentUserId={me.user.id}
              fixedProjectId={fixedProjectId}
              onCreated={handleCreated}
              organizationId={me.context.organizationId}
              projects={projectsQuery.data ?? []}
              users={usersQuery.data ?? []}
            />
          ) : null}
        </NestedStage>

        {pairingCommand && created ? (
          <section className="admin-card grid gap-2 border border-[color:var(--accent)] p-4">
            <h2 className="text-sm font-semibold text-[color:var(--tx)]">Finish pairing on the companion</h2>
            <p className="text-xs text-[color:var(--tx3)]">Replace the workspace placeholder with one existing absolute directory. The companion stores its canonical root and machine key in owner-only state, and can only read bounded files under that root. This invitation expires at {created.invitation.expiresAt}.</p>
            <p className="text-xs text-[color:var(--tx3)]">Supported platforms: macOS 15+ on Apple Silicon, Ubuntu Linux x86_64, Windows 11/10 x86_64 (Windows and Linux support arrive with their releases).</p>
            <code className="overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx)]">{pairingCommand}</code>
          </section>
        ) : null}

        <ExecutorDesktopCompanionPanel created={created} executorId={selected?.id} />

        {reviewChange ? (
          <section className="admin-card grid gap-3 border border-[color:var(--accent)] p-4">
            <div>
              <h2 className="text-sm font-semibold text-[color:var(--tx)]">Review prepared executor change</h2>
              <p className="mt-1 text-xs text-[color:var(--tx3)]">This one-time change expires at {reviewChange.expiresAt}. It is bound to your account and the executor’s current authorization revision.</p>
            </div>
            <pre className="overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx2)]">{JSON.stringify(reviewChange.change, null, 2)}</pre>
            <FormError>
              {!confirmationToken
                ? 'The confirmation token is missing. Recreate the change from this page or reopen the Personal Assistant review link.'
                : undefined}
            </FormError>
            {reviewChange.requiresFreshVerification ? (
              <label className="grid max-w-sm gap-1 text-xs font-medium text-[color:var(--tx2)]">
                Confirm with current password
                <input className="admin-input" onChange={(event) => setCurrentPassword(event.target.value)} type="password" value={currentPassword} />
              </label>
            ) : null}
            <FormError>{reviewError}</FormError>
            <div className="flex flex-wrap gap-2">
              <button className="admin-button admin-button-primary" disabled={!confirmationToken || confirmChange.isPending} onClick={() => void handleConfirmChange()} type="button">Confirm change</button>
              <button className="admin-button admin-button-secondary" disabled={!confirmationToken || rejectChange.isPending} onClick={() => void handleRejectChange()} type="button">Reject</button>
            </div>
          </section>
        ) : null}

        {promotionChange ? (
          <section className="admin-card grid gap-3 border border-[color:var(--accent)] p-4">
            <div>
              <h2 className="text-sm font-semibold text-[color:var(--tx)]">Confirm workspace promotion</h2>
              <p className="mt-1 text-xs text-[color:var(--tx3)]">
                This promotes {promotionChange.changeCount} reviewed change{promotionChange.changeCount === 1 ? '' : 's'}
                {' '}only if the daemon reconstructs the same manifest digest and the host root is unchanged.
                It expires at {promotionChange.expiresAt}.
              </p>
              <code className="mt-2 block overflow-x-auto rounded bg-[color:var(--overlay-weak)] p-2 text-xs text-[color:var(--tx2)]">{promotionChange.manifestDigest}</code>
            </div>
            <FormError>
              {!confirmationToken
                ? 'The confirmation token is missing. Prepare the promotion again from your reviewed drafts.'
                : undefined}
            </FormError>
            <label className="grid max-w-sm gap-1 text-xs font-medium text-[color:var(--tx2)]">
              Confirm with current password
              <input className="admin-input" onChange={(event) => setCurrentPassword(event.target.value)} type="password" value={currentPassword} />
            </label>
            <FormError>{reviewError}</FormError>
            <div className="flex flex-wrap gap-2">
              <button className="admin-button admin-button-primary" disabled={!confirmationToken || confirmPromotion.isPending} onClick={() => void handleConfirmPromotion()} type="button">Confirm promotion</button>
              <button className="admin-button admin-button-secondary" disabled={!confirmationToken || rejectPromotion.isPending} onClick={() => void handleRejectPromotion()} type="button">Reject</button>
            </div>
          </section>
        ) : null}

        <ExecutorWorkspacePromotionsPanel
          executors={executors}
          isError={myReviewsQuery.isError}
          isLoading={myReviewsQuery.isLoading}
          onPrepare={(reviewCommandId) => void handlePreparePromotion(reviewCommandId)}
          preparingReviewId={preparePromotion.isPending ? preparePromotion.variables?.reviewCommandId : undefined}
          refetch={myReviewsQuery.refetch}
          reviews={myReviewsQuery.data ?? []}
        />

        <div className="grid min-h-[460px] gap-4 lg:grid-cols-[minmax(230px,0.33fr)_minmax(0,0.67fr)]">
          <aside className="admin-card min-h-0 p-3">
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold text-[color:var(--tx)]">Available to you</h2><span className="text-xs text-[color:var(--tx3)]">{executors.length}</span></div>
            <QueryState
              className="py-6"
              emptyLabel="No executor is visible to you. Pair one, or ask its human administrator to assign you."
              errorLabel="Executors could not be loaded."
              isEmpty={executors.length === 0}
              loadingLabel="Loading executors…"
              query={executorsQuery}
            >
              {() => (
                <RowList label="Available executors">
                  {executors.map((executor) => (
                    <Row
                      key={executor.id}
                      onClick={() => setSelection(executor.id)}
                      selected={executor.id === selected?.id}
                      title={executor.label}
                      trailing={
                        <>
                          <span className={statusClass(executor.status)}>{executor.status}</span>
                          <span className="text-[color:var(--tx3)]">{executor.scope.kind}</span>
                        </>
                      }
                    />
                  ))}
                </RowList>
              )}
            </QueryState>
          </aside>
          {selected ? <ExecutorDetailPanels access={accessQuery.data} agents={agentsQuery.data ?? []} executor={selected} onPrepared={openReview} reviews={reviewsQuery.data ?? []} users={usersQuery.data ?? []} /> : <section className="admin-card flex items-center justify-center p-6 text-sm text-[color:var(--tx3)]">Select an executor to inspect its boundary and effective access.</section>}
        </div>

        {selected?.status === 'pending_pairing' ? (
          <section className="admin-card flex flex-wrap items-center gap-3 p-4 text-sm text-[color:var(--tx2)]">
            <span>When the companion has submitted its descriptor, inspect and confirm the fingerprint here.</span>
            <button className="admin-button admin-button-secondary" onClick={() => void pendingPairing.refetch()} type="button">Check pairing</button>
            {pendingPairing.data ? <><code className="text-xs">{pendingPairing.data.fingerprint}</code><button className="admin-button admin-button-primary" disabled={confirmPairing.isPending} onClick={() => void confirmPairing.mutateAsync({ executorId: selected.id, fingerprint: pendingPairing.data!.fingerprint })} type="button">Confirm fingerprint</button></> : null}
          </section>
        ) : null}
        </div>
      </div>
    </div>
  )
}
