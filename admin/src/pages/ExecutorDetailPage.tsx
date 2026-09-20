import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import { ExecutorDesktopCompanionPanel } from '../components/features/executors/ExecutorDesktopCompanionPanel'
import { ExecutorDetailPanels } from '../components/features/executors/ExecutorDetailPanels'
import { ExecutorAccessChangeDialog } from '../components/features/executors/ExecutorReviewDialogs'
import { LocalInferenceHostStatus } from '../components/features/local-inference/LocalInferenceHostStatus'
import {
  EXECUTOR_STATUS_LABELS,
  executorScopeSummary,
  executorStatusTone,
} from '../components/features/executors/executor-presentation'
import { Pill } from '../components/primitives/Pill'
import { SectionLabel } from '../components/primitives/SectionLabel'
import { QueryState } from '../components/shared/QueryState'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { useAgents } from '../facades/agents/hooks'
import {
  useConfirmExecutorEnrollment,
  useExecutorAccess,
  useExecutors,
  useExecutorWorkspaceReviews,
  usePendingExecutorEnrollment,
} from '../facades/executors/hooks'
import { useUsers } from '../facades/users/hooks'

/**
 * One paired machine: its boundary, its effective access, the operations its
 * agents may run, its sessions, and — on Nessie Desktop — this computer's own
 * daemon controls.
 *
 * Reached by opening a row in the Executors table. Every change it prepares is
 * a one-time, separately confirmed change, so the confirmation is a modal over
 * this screen and its token never enters the address.
 */
export const ExecutorDetailPage = () => {
  const navigate = useNavigate()
  const { executorId } = useParams<{ executorId?: string }>()
  const executorsQuery = useExecutors()
  const executor = (executorsQuery.data ?? []).find((candidate) => candidate.id === executorId)
  const accessQuery = useExecutorAccess(executorId)
  const reviewsQuery = useExecutorWorkspaceReviews(executorId)
  const agentsQuery = useAgents()
  const usersQuery = useUsers()
  const pendingPairing = usePendingExecutorEnrollment(executorId)
  // A plain const narrows across the closure below; `pendingPairing.data`
  // itself does not.
  const pendingFingerprint = pendingPairing.data?.fingerprint
  const confirmPairing = useConfirmExecutorEnrollment()
  const [prepared, setPrepared] = useState<PreparedExecutorAccessChangeResponse | null>(null)

  const backToList = () => void navigate('/agents/executors')

  if (!executor) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ScreenHeader backLabel="Back to Executors" onBack={backToList} title="Executor" />
        <QueryState
          className="flex flex-1 items-center justify-center"
          emptyLabel="This executor could not be found, or it is no longer visible to you."
          errorLabel="Executors could not be loaded."
          isEmpty
          loadingLabel="Loading executor…"
          query={executorsQuery}
        >
          {() => null}
        </QueryState>
      </div>
    )
  }

  // The loaded revisions belong to this executor, so they describe the prepared
  // change only when that change is this executor's.
  const preparedRevisions = prepared && prepared.executorId === accessQuery.data?.executorId
    ? accessQuery.data?.descriptorRevisions
    : undefined

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScreenHeader
        backLabel="Back to Executors"
        eyebrow="Executors"
        onBack={backToList}
        subtitle={
          <div className="flex flex-wrap items-center gap-2">
            <Pill height="control" tone={executorStatusTone(executor.status)} uppercase={false}>
              {EXECUTOR_STATUS_LABELS[executor.status]}
            </Pill>
            <p className="text-sm text-[color:var(--tx3)]">{executorScopeSummary(executor)}</p>
          </div>
        }
        title={executor.label}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4">
        <div className="grid gap-4">
          {executor.status === 'pending_pairing' ? (
            <section className="flex flex-wrap items-center gap-3 rounded-xl border border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx2)]">
              <span>When the companion has submitted its descriptor, inspect and confirm the fingerprint here.</span>
              <button
                className="admin-button admin-button-secondary"
                onClick={() => void pendingPairing.refetch()}
                type="button"
              >
                Check pairing
              </button>
              {pendingFingerprint ? (
                <>
                  <code className="text-xs">{pendingFingerprint}</code>
                  <button
                    className="admin-button admin-button-primary"
                    disabled={confirmPairing.isPending}
                    onClick={() => {
                      // No local onError: the app-wide mutation default
                      // (providers/QueryProvider.tsx) surfaces a failure as a
                      // toast; `.catch` here only stops an unhandled rejection.
                      void confirmPairing
                        .mutateAsync({ executorId: executor.id, fingerprint: pendingFingerprint })
                        .catch(() => undefined)
                    }}
                    type="button"
                  >
                    Confirm fingerprint
                  </button>
                </>
              ) : null}
            </section>
          ) : null}

          <ExecutorDesktopCompanionPanel executorId={executor.id} />

          <section className="grid gap-2">
            <div>
              <SectionLabel as="h2">Local Ollama</SectionLabel>
              <p className="mt-1 text-sm text-[color:var(--tx2)]">
                This executor’s local model status and controls.
              </p>
            </div>
            <LocalInferenceHostStatus
              empty={(
                <p className="text-sm text-[color:var(--tx2)]">
                  This executor has not connected a local Ollama host.
                </p>
              )}
              executorId={executor.id}
            />
          </section>

          <ExecutorDetailPanels
            accessQuery={accessQuery}
            agents={agentsQuery.data ?? []}
            executor={executor}
            onPrepared={setPrepared}
            reviews={reviewsQuery.data ?? []}
            users={usersQuery.data ?? []}
          />
        </div>
      </div>

      {prepared ? (
        <ExecutorAccessChangeDialog
          accessChangeId={prepared.accessChangeId}
          confirmationToken={prepared.confirmationToken}
          {...(preparedRevisions ? { descriptorRevisions: preparedRevisions } : {})}
          onClose={() => setPrepared(null)}
          open
        />
      ) : null}
    </div>
  )
}
