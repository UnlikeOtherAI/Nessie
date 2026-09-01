import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  useInstallWorkflowTemplate,
  useRecordWorkflowStepSamples,
  useStartWorkflowRun,
  useWorkflowInstallations,
  useWorkflowRun,
} from '../../facades/workflows/hooks'
import { useIsOwner } from '../../components/shared/OwnerGate'
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
  const isOwner = useIsOwner()
  const installationsQuery = useWorkflowInstallations(isOwner)
  const installTemplate = useInstallWorkflowTemplate()
  const startRun = useStartWorkflowRun()

  const [runId, setRunId] = useState<string | undefined>()
  const [isStarting, setIsStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runQuery = useWorkflowRun(runId, true, true)
  const run = runQuery.data?.run
  const steps = useMemo(() => runQuery.data?.steps ?? [], [runQuery.data?.steps])

  // §5: a completed test run persists its redacted per-step outputs as the
  // template's stepSamples, so the field picker works on reopen without
  // re-running. The server re-checks entitlement, provenance, quota and
  // redaction; a failure here only loses the convenience, not the run.
  const recordSamples = useRecordWorkflowStepSamples()
  const recordedRunIdRef = useRef<string | null>(null)
  const templateIdForSamples = run?.installationId ? workflowTemplateId : undefined
  const installationId = run?.installationId
  useEffect(() => {
    if (
      !run ||
      run.status !== 'completed' ||
      !templateIdForSamples ||
      !installationId ||
      recordedRunIdRef.current === run.id
    ) {
      return
    }
    recordedRunIdRef.current = run.id
    const stepOutputs = Object.fromEntries(
      steps
        .filter((step) => step.status === 'completed')
        .map((step) => [step.stepKey, step.output]),
    )
    recordSamples.mutate({
      stepOutputs,
      workflowInstallationId: installationId,
      workflowRunId: run.id,
      workflowTemplateId: templateIdForSamples,
    })
  }, [installationId, recordSamples, run, steps, templateIdForSamples])

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
