import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useMemo, useState } from 'react'
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
import { TabBar } from '../components/primitives/TabBar'
import { createListPageStore } from '../components/shared/list-page-state'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import type { PageHeaderAction } from '../components/shared/ResponsivePageHeader'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import {
  useExecutors,
  useMyExecutorWorkspaceReviews,
} from '../facades/executors/hooks'
import { useProjects } from '../facades/projects/hooks'
import { useScrollMemory } from '../hooks/useScrollMemory'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { parseHashParam, useConsumedHashIntent, useConsumedIntents } from '../navigation/intent'
import { useTabParam } from '../navigation/useTabParam'
import { COMPUTER_SESSIONS_PATH, computerPath } from '../navigation/computers'

// A project's "add executor" doorway (`?create=project&scopeProjectId=`) and
// a Personal Assistant review link (`#confirmationToken=`) are one-shot
// intents the registry declares for this route (docs/navigation/overview.md §8): both
// are captured once and stripped, so the token never survives in history or
// a shared address. A token this page mints itself lives in state only.
const CREATE_INTENTS = ['create', 'scopeProjectId'] as const
const parseConfirmationToken = parseHashParam('confirmationToken')

const OWNERSHIP_FILTERS = ['mine', 'shared'] as const
type OwnershipFilter = (typeof OWNERSHIP_FILTERS)[number]

const OWNERSHIP_LABEL: Record<OwnershipFilter, string> = {
  mine: 'Mine',
  shared: 'Shared with me',
}

/**
 * The paired-computer list, at two scopes: every computer this person may use
 * (Admin › Computers), and their own — the ones they paired and the ones shared
 * with them (Your settings › Your computers). One component, because it is one
 * list; both open the same computer page.
 *
 * The same shape as every other browsable list in the section: one header, one
 * table, one pager. Everything that used to sit on this page as a stack of
 * cards — the pairing form and its invitation, a prepared change waiting to be
 * confirmed, your reviewed drafts — is a modal, and everything that belongs to
 * one machine is its own screen at `/admin/computers/:executorId`.
 */
const executorsListStore = createListPageStore()

const ComputersList = ({ scope }: { scope: 'all' | 'personal' }) => {
  const { me } = useAuthSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const createIntent = useConsumedIntents(CREATE_INTENTS)
  const fixedProjectId = createIntent.values.create === 'project'
    ? createIntent.values.scopeProjectId ?? undefined
    : undefined
  const pairingAudience = createIntent.values.create === 'team' ? 'team' : 'personal'
  const [showPair, setShowPair] = useState(false)
  const [showDrafts, setShowDrafts] = useState(false)
  const linkedToken = useConsumedHashIntent('confirmationToken', parseConfirmationToken)
  const [confirmationToken, setConfirmationToken] = useState<string | null>(null)
  // A promotion prepared here, rather than linked to. Its token is never put in
  // the address; it lives only until the confirmation closes.
  const [prepared, setPrepared] = useState<PreparedExecutorPromotion | null>(null)
  const [ownership, setOwnership] = useTabParam('filter', OWNERSHIP_FILTERS, 'mine')

  const executorsQuery = useExecutors()
  const personal = scope === 'personal'
  const executors = useMemo(() => {
    const visible = executorsQuery.data ?? []
    if (!personal) return visible
    return visible.filter((executor) =>
      (executor.pairedByViewer === true) === (ownership === 'mine'))
  }, [executorsQuery.data, ownership, personal])
  const projectsQuery = useProjects()
  const myReviewsQuery = useMyExecutorWorkspaceReviews()
  const draftCount = myReviewsQuery.data?.length ?? 0

  const [initialState] = useState(executorsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  useEffect(() => {
    if (fixedProjectId || ['personal', 'team'].includes(createIntent.values.create ?? '')) setShowPair(true)
  }, [createIntent.serial, createIntent.values.create, fixedProjectId])
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

  const scroll = useScrollMemory(personal ? 'executors:personal-list' : 'executors:list')

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

  const pairAction: PageHeaderAction = {
    icon: faPlus,
    id: 'pair-computer',
    label: 'Pair a computer',
    onSelect: () => setShowPair(true),
    primary: true,
    priority: 100,
  }
  // Reviewed drafts stay on the full list: it shows reviews from machines the
  // person can no longer open, which no single computer's page can.
  const actions: PageHeaderAction[] = personal ? [pairAction] : [
    { href: COMPUTER_SESSIONS_PATH, id: 'sessions', kind: 'link', label: 'Sessions', priority: 80 },
    {
      id: 'reviewed-drafts',
      label: draftCount > 0 ? `Reviewed drafts (${draftCount})` : 'Reviewed drafts',
      onSelect: () => setShowDrafts(true),
      priority: 60,
    },
    pairAction,
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* One header: the section's eyebrow, its title, the sentence that says
          what a computer is here, and the measured actions — which fold into
          More rather than wrapping into a ragged row. */}
      <ScreenHeader
        actions={actions}
        eyebrow={personal ? 'Your settings' : 'Agents'}
        subtitle={
          <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
            {personal
              ? 'The computers you paired, and the ones other people share with you. Open one to '
                + 'choose which agents may use it and who it is shared with.'
              : 'Pair governed sandboxes and coding sessions. Executors are separate from connectors: '
                + 'connectors provide remote services; executors run approved work on a paired machine '
                + 'or guest runtime.'}
          </p>
        }
        tabs={personal ? (
          <TabBar
            ariaLabel="Whose computers"
            items={OWNERSHIP_FILTERS.map((value) => ({ label: OWNERSHIP_LABEL[value], value }))}
            onChange={(next) => {
              setOwnership(next)
              setRequestedPage(0)
            }}
            role="radiogroup"
            value={ownership}
          />
        ) : undefined}
        title={personal ? 'Your computers' : 'Computers'}
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <ExecutorsTable
          emptyMessage={
            !personal
              ? 'No executor is visible to you. Pair one, or ask its human administrator to assign you.'
              : ownership === 'mine'
                ? 'You have not paired a computer yet.'
                : 'Nobody has shared a computer with you.'
          }
          executors={pageExecutors}
          isLoading={executorsQuery.isPending}
          onOpen={(executorId) => void navigate(computerPath(executorId))}
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
            ? 'No computers'
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
          initialAudience={pairingAudience}
          {...(fixedProjectId ? { fixedProjectId } : {})}
          onClose={() => setShowPair(false)}
          onFinished={(executorId) => {
            setShowPair(false)
            void navigate(computerPath(executorId))
          }}
          open={showPair}
          projects={projectsQuery.data ?? []}
        />
      ) : null}

      {personal ? null : (
        <ExecutorDraftsDialog
          executors={executors}
          onClose={() => setShowDrafts(false)}
          onPrepared={(promotion) => {
            setShowDrafts(false)
            setPrepared(promotion)
          }}
          open={showDrafts}
        />
      )}

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

/** Admin › Computers: every computer this person may use. */
export const ComputersPage = () => <ComputersList scope="all" />

/** Your settings › Your computers: the ones they paired, and the ones shared with them. */
export const YourComputersPage = () => <ComputersList scope="personal" />
