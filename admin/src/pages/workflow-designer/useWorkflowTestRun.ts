import { useCallback, useMemo, useState } from 'react'
import {
  useInstallWorkflowTemplate,
  useStartWorkflowRun,
  useWorkflowInstallations,
  useWorkflowRun,
} from '../../facades/workflows/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type {
  WorkflowStepRunRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'

/**
 * Test-run from the designer: persist the current graph, ensure an
 * installation exists (reusing an active one, installing otherwise), start a
 * run, then poll it while it executes. Step results map back onto canvas
 * nodes via `stepKey`, which the worker sets to the graph step id — the same
 * id the canvas uses for its nodes.
 */

export type WorkflowTestRunState =
  | 'completed'
  | 'failed'
  | 'idle'
  | 'running'
  | 'starting'

type UseWorkflowTestRunInput = {
  persistWorkflow: (mode: 'auto' | 'manual') => Promise<WorkflowTemplateRecord | null>
  workflowTemplateId?: string
}

export const useWorkflowTestRun = ({
  persistWorkflow,
  workflowTemplateId,
}: UseWorkflowTestRunInput) => {
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const installationsQuery = useWorkflowInstallations(isOwner)
  const installTemplate = useInstallWorkflowTemplate()
  const startRun = useStartWorkflowRun()

  const [runId, setRunId] = useState<string | undefined>()
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runQuery = useWorkflowRun(runId, true, true)
  const run = runQuery.data?.run
  const steps = useMemo(() => runQuery.data?.steps ?? [], [runQuery.data?.steps])

  const stepRunsByNodeId = useMemo(() => {
    const map = new Map<string, WorkflowStepRunRecord>()
    for (const step of steps) {
      map.set(step.stepKey, step)
    }
    return map
  }, [steps])

  const startTestRun = useCallback(async () => {
    setError(null)
    setIsStarting(true)
    setRunId(undefined)

    try {
      const saved = await persistWorkflow('manual')
      const templateId = saved?.id ?? workflowTemplateId
      if (!templateId) {
        setError('Add at least one step and a name before running.')
        return
      }

      const installations = installationsQuery.data ?? []
      const existing =
        installations.find(
          (entry) =>
            entry.workflowTemplateId === templateId &&
            entry.active &&
            entry.status === 'active',
        ) ??
        installations.find(
          (entry) => entry.workflowTemplateId === templateId && entry.active,
        )

      const installation =
        existing ?? (await installTemplate.mutateAsync({ workflowTemplateId: templateId }))

      const startedRun = await startRun.mutateAsync({
        installationId: installation.id,
        input: {},
      })
      setRunId(startedRun.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start test run.')
    } finally {
      setIsStarting(false)
    }
  }, [
    installTemplate,
    installationsQuery.data,
    persistWorkflow,
    startRun,
    workflowTemplateId,
  ])

  const state: WorkflowTestRunState = isStarting
    ? 'starting'
    : !run
      ? 'idle'
      : run.status === 'pending' || run.status === 'running'
        ? 'running'
        : run.status === 'completed'
          ? 'completed'
          : 'failed'

  return {
    error,
    run,
    startTestRun,
    state,
    stepRunsByNodeId,
  }
}
