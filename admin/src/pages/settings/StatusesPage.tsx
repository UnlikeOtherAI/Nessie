import { useEffect, useMemo, useState } from 'react'
import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useNavigate } from 'react-router-dom'
import { useClearActiveStatus, useStatuses } from '../../facades/statuses/hooks'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { FormError } from '../../components/shared/FormActions'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { createListPageStore } from '../../components/shared/list-page-state'
import { CreateStatusDialog } from './statuses/CreateStatusDialog'
import { StatusesTable } from './statuses/StatusesTable'

const statusesListStore = createListPageStore()

/**
 * Statuses — the list.
 *
 * It was a two-column card layout: an add form and a rail of status cards on
 * the left, the selected status's editor on the right, both in one component.
 * It is now the admin's ordinary list shape — one header, one table, one pager
 * — and a status is its own screen at `/settings/statuses/:statusId`, which is
 * the route it already had.
 */
export const StatusesPage = () => {
  const navigate = useNavigate()
  const statuses = useStatuses()
  // Memoised so the empty-array fallback is not a fresh literal every render.
  const statusRows = useMemo(() => statuses.data ?? [], [statuses.data])
  const clearActiveStatus = useClearActiveStatus()
  const [createOpen, setCreateOpen] = useState(false)
  // A clear that silently failed would leave a person believing their status
  // was down when everyone can still see it, which is the one outcome this
  // screen must never produce.
  const [actionError, setActionError] = useState<string | null>(null)

  const [initialState] = useState(statusesListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  const totalPages = Math.max(1, Math.ceil(statusRows.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageStatuses = statusRows.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = statusRows.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, statusRows.length)

  useEffect(() => {
    statusesListStore.save({ page, pageSize })
  }, [page, pageSize])

  const actions: PageHeaderAction[] = [
    {
      disabled: clearActiveStatus.isPending,
      id: 'clear-active',
      label: 'Clear active',
      onSelect: () => {
        setActionError(null)
        clearActiveStatus.mutate(undefined, {
          onError: (error) =>
            setActionError(
              error instanceof Error
                ? error.message
                : 'Your active status could not be cleared. It is still showing.',
            ),
        })
      },
      priority: 40,
    },
    {
      icon: faPlus,
      id: 'new-status',
      label: 'New status',
      onSelect: () => setCreateOpen(true),
      primary: true,
      priority: 100,
    },
  ]

  return (
    <SettingsPanel
      actions={actions}
      eyebrow="User"
      // Always visible: an empty or single-page list keeps its size control,
      // and the table above it does not grow and shrink as pages change.
      footer={
        <PaginationFooter
          canNext={page < totalPages - 1}
          canPrevious={page > 0}
          className="px-6 py-3"
          label={
            statusRows.length === 0
              ? 'No statuses'
              : `${rangeStart}–${rangeEnd} of ${statusRows.length}`
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
      }
      subtitle={
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
          What you are doing, shown beside your name. Each one can carry a schedule that turns
          it on by itself, and contact rules that decide who still reaches you.
        </p>
      }
      title="Statuses"
    >
      <FormError className="mb-3">{actionError}</FormError>

      <StatusesTable
        emptyMessage="No statuses yet. Add one to say what you are doing."
        isLoading={statuses.isPending}
        onOpen={(statusId) => void navigate(`/settings/statuses/${statusId}`)}
        statuses={pageStatuses}
      />

      <CreateStatusDialog onClose={() => setCreateOpen(false)} open={createOpen} />
    </SettingsPanel>
  )
}
