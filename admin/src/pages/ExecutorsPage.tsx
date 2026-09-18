import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ExecutorDraftsDialog,
  type PreparedExecutorPromotion,
} from '../components/features/executors/ExecutorDraftsDialog'
import { ExecutorPairDialog } from '../components/features/executors/ExecutorPairDialog'
import {
  ExecutorAccessChangeDialog,
  ExecutorPromotionDialog,
} from '../components/features/executors/ExecutorReviewDialogs'
import { ExecutorsTable } from '../components/features/executors/ExecutorsTable'
import { createListPageStore } from '../components/shared/list-page-state'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAgents } from '../facades/agents/hooks'
import {
  useExecutors,
  useMyExecutorWorkspaceReviews,
} from '../facades/executors/hooks'
import { useProjects } from '../facades/projects/hooks'
import { useUsers } from '../facades/users/hooks'
import { useScrollMemory } from '../hooks/useScrollMemory'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { parseHashParam, useConsumedHashIntent, useConsumedIntents } from '../navigation/intent'

// A project's "add executor" doorway (`?create=project&scopeProjectId=`) and
// a Personal Assistant review link (`#confirmationToken=`) are one-shot
// intents the registry declares for this route (docs/navigation/overview.md §8): both
// are captured once and stripped, so the token never survives in history or
// a shared address. A token this page mints itself lives in state only.
const CREATE_INTENTS = ['create', 'scopeProjectId'] as const
const parseConfirmationToken = parseHashParam('confirmationToken')

/**
 * Executors — the paired-machine list.
 *
 * The same shape as every other browsable list in the section: one header, one
 * table, one pager. Everything that used to sit on this page as a stack of
 * cards — the pairing form and its invitation, a prepared change waiting to be
 * confirmed, your reviewed drafts — is a modal, and everything that belongs to
 * one machine is its own screen at `/agents/executors/:executorId`.
 */
const executorsListStore = createListPageStore()

export const ExecutorsPage = () => {
  const { me } = useAuthSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const createIntent = useConsumedIntents(CREATE_INTENTS)
  const fixedProjectId = createIntent.values.create === 'project'
    ? createIntent.values.scopeProjectId ?? undefined
    : undefined
  const [showPair, setShowPair] = useState(false)
  const [showDrafts, setShowDrafts] = useState(false)
  const linkedToken = useConsumedHashIntent('confirmationToken', parseConfirmationToken)
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null)
  // A promotion prepared here, rather than linked to. Its token is never put in
  // the address; it lives only until the confirmation closes.
  const [prepared, setPrepared] = useState<PreparedExecutorPromotion | null>(null)

  const executorsQuery = useExecutors()
  const executors = executorsQuery.data ?? []
  const agentsQuery = useAgents()
  const usersQuery = useUsers()
  const projectsQuery = useProjects()
  const myReviewsQuery = useMyExecutorWorkspaceReviews()
  const draftCount = myReviewsQuery.data?.length ?? 0

  const [initialState] = useState(executorsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  useEffect(() => {
    if (fixedProjectId) setShowPair(true)
  }, [createIntent.serial, fixedProjectId])
  useEffect(() => {
    if (linkedToken.value) setConfirmationToken(linkedToken.value)
  }, [linkedToken])

  const totalPages = Math.max(1, Math.ceil(executors.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageExecutors = executors.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = executors.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, executors.length)

  useEffect(() => {
    executorsListStore.save({ page, pageSize })
  }, [page, pageSize])

  const scroll = useScrollMemory('executors:list')

  // A linked review names its change in the query; one prepared here carries
  // its own id. Either way the token is held in memory beside it.
  const linkedAccessChangeId = searchParams.get('accessChange')
  const linkedPromotionId = searchParams.get('promotion')
  const promotionId = prepared?.promotionId ?? linkedPromotionId
  const promotionToken = prepared ? prepared.confirmationToken : confirmationToken

  const clearLinkedReview = () => {
    const next = new URLSearchParams(searchParams)
    next.delete('accessChange')
    next.delete('promotion')
    setSearchParams(next, { replace: true })
    setConfirmationToken(null)
    setPrepared(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One header: the section's eyebrow, its title, the sentence that says
          what an executor is, and the measured actions — which fold into More
          rather than wrapping into a ragged row. */}
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
            id: 'reviewed-drafts',
            label: draftCount > 0 ? `Reviewed drafts (${draftCount})` : 'Reviewed drafts',
            onSelect: () => setShowDrafts(true),
            priority: 60,
          },
          {
            icon: faPlus,
            id: 'pair-executor',
            label: 'Pair executor',
            onSelect: () => setShowPair(true),
            primary: true,
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

      <div
        className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <ExecutorsTable
          emptyMessage="No executor is visible to you. Pair one, or ask its human administrator to assign you."
          executors={pageExecutors}
          isLoading={executorsQuery.isPending}
          onOpen={(executorId) => void navigate(`/agents/executors/${executorId}`)}
        />
      </div>

      {/* Always visible: an empty or single-page list keeps its size control,
          and the table above it does not grow and shrink as pages change. */}
      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        className="px-6 py-3"
        label={
          executors.length === 0
            ? 'No executors'
            : `${rangeStart}–${rangeEnd} of ${executors.length}`
        }
        onPageChange={setRequestedPage}
        onPageSizeChange={(next) => {
          setPageSize(next)
          setRequestedPage(0)
        }}
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
      />

      {me ? (
        <ExecutorPairDialog
          agents={agentsQuery.data ?? []}
          currentUserId={me.user.id}
          {...(fixedProjectId ? { fixedProjectId } : {})}
          onClose={() => setShowPair(false)}
          onFinished={(created) => {
            setShowPair(false)
            void navigate(`/agents/executors/${created.executor.id}`)
          }}
          open={showPair}
          organizationId={me.context.organizationId}
          projects={projectsQuery.data ?? []}
          users={usersQuery.data ?? []}
        />
      ) : null}

      <ExecutorDraftsDialog
        executors={executors}
        onClose={() => setShowDrafts(false)}
        onPrepared={(promotion) => {
          setShowDrafts(false)
          setPrepared(promotion)
        }}
        open={showDrafts}
      />

      {linkedAccessChangeId ? (
        <ExecutorAccessChangeDialog
          accessChangeId={linkedAccessChangeId}
          confirmationToken={confirmationToken}
          onClose={clearLinkedReview}
          open
        />
      ) : null}

      {promotionId ? (
        <ExecutorPromotionDialog
          confirmationToken={promotionToken}
          onClose={clearLinkedReview}
          open
          promotionId={promotionId}
        />
      ) : null}
    </div>
  )
}
