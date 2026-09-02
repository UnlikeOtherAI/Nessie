import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentTriggerRecord,
  WorkflowInstallationRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowStepSamplesRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'
import { workflowKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useWorkflowTemplates = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowTemplateRecord[]>({
    queryKey: workflowKeys.templates,
    queryFn: () => apiClient.get('/api/workflows'),
    enabled,
  })
}

export const useWorkflowTemplate = (
  workflowTemplateId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowTemplateRecord>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.template(workflowTemplateId),
    queryFn: () => apiClient.get(`/api/workflows/${workflowTemplateId}`),
    enabled: enabled && Boolean(workflowTemplateId),
  })
}

export const useCreateWorkflowTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      bindingSchema?: unknown
      description?: string
      graph: WorkflowTemplateRecord['graph']
      name: string
      requiredEnvironmentTemplateIds?: string[]
      triggers?: unknown
      variableSchema?: unknown
    }) => apiClient.post<WorkflowTemplateRecord>('/api/workflows', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.templates })
    },
  })
}

export const useUpdateWorkflowTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      workflowTemplateId: string
      bindingSchema?: unknown
      description?: string
      graph: WorkflowTemplateRecord['graph']
      name: string
      requiredEnvironmentTemplateIds?: string[]
      triggers?: unknown
      variableSchema?: unknown
    }) => {
      const { workflowTemplateId, ...body } = input
      return apiClient.put<WorkflowTemplateRecord>(`/api/workflows/${workflowTemplateId}`, body)
    },
    onSuccess: (workflow) => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.templates })
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.template(workflow.id),
      })
    },
  })
}

export const useWorkflowInstallations = (enabled = true, channelId?: string) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowInstallationRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.installationsForChannel(channelId),
    queryFn: () =>
      apiClient.get(
        channelId
          ? `/api/workflow-installations?channelId=${encodeURIComponent(channelId)}`
          : '/api/workflow-installations',
      ),
    enabled,
  })
}

// W29: cross-installation "what failed" feed for the triage surface.
export const useFailedWorkflowRuns = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowRunRecord[]>({
    queryKey: workflowKeys.failedRuns,
    queryFn: () => apiClient.get('/api/workflow-runs?status=failed'),
    enabled,
  })
}

export const useUpdateWorkflowInstallation = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      installationId: string
      status?: WorkflowInstallationRecord['status']
    }) => {
      const { installationId, ...body } = input
      return apiClient.patch<WorkflowInstallationRecord>(
        `/api/workflow-installations/${installationId}`,
        body,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.installations })
    },
  })
}

export const useInstallWorkflowTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      workflowTemplateId: string
      active?: boolean
      channelId?: string
      config?: Record<string, unknown>
      resolvedBindings?: Record<string, unknown>
      status?: WorkflowInstallationRecord['status']
    }) => {
      const { workflowTemplateId, ...body } = input
      return apiClient.post<WorkflowInstallationRecord>(
        `/api/workflows/${workflowTemplateId}/install`,
        body,
      )
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowKeys.installations })
      void queryClient.invalidateQueries({ queryKey: workflowKeys.templates })
    },
  })
}

export const useWorkflowInstallationRuns = (
  installationId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowRunRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.installationRuns(installationId),
    queryFn: () =>
      apiClient.get(`/api/workflow-installations/${installationId}/runs`),
    enabled: enabled && Boolean(installationId),
  })
}

// §5 stepSamples: the last successful test run's redacted per-step output,
// served by the owner-gated route. 404 (no samples yet) reads as "nothing
// persisted" rather than an error state in the inspector.
export const useWorkflowStepSamples = (
  workflowTemplateId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowStepSamplesRecord | null>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.templateStepSamples(workflowTemplateId),
    queryFn: async () => {
      try {
        return await apiClient.get<WorkflowStepSamplesRecord>(
          `/api/workflows/${workflowTemplateId}/step-samples`,
        )
      } catch {
        return null
      }
    },
    enabled: enabled && Boolean(workflowTemplateId),
  })
}

export const useRecordWorkflowStepSamples = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      stepOutputs: Record<string, unknown>
      workflowInstallationId: string
      workflowRunId: string
      workflowTemplateId: string
    }) =>
      apiClient.post<{ result: string }>(
        `/api/workflows/${input.workflowTemplateId}/step-samples`,
        {
          stepOutputs: input.stepOutputs,
          workflowInstallationId: input.workflowInstallationId,
          workflowRunId: input.workflowRunId,
        },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.templateStepSamples(variables.workflowTemplateId),
      })
    },
  })
}

export const useWorkflowInstallationTriggers = (
  installationId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.installationTriggers(installationId),
    queryFn: () =>
      apiClient.get(`/api/workflow-installations/${installationId}/triggers`),
    enabled: enabled && Boolean(installationId),
  })
}

export const useWorkflowRun = (
  workflowRunId?: string,
  enabled = true,
  pollWhileActive = false,
) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowRunDetail>({
    placeholderData: keepPreviousData,
    queryKey: workflowKeys.run(workflowRunId),
    queryFn: () => apiClient.get(`/api/workflow-runs/${workflowRunId}`),
    enabled: enabled && Boolean(workflowRunId),
    refetchInterval: pollWhileActive
      ? (query) => {
          const status = query.state.data?.run.status
          return status === 'pending' || status === 'running' ? 1500 : false
        }
      : undefined,
  })
}

export const useStartWorkflowRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      installationId: string
      input?: Record<string, unknown>
    }) =>
      apiClient.post<WorkflowRunRecord>(
        `/api/workflow-installations/${input.installationId}/run`,
        { input: input.input },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.installationRuns(variables.installationId),
      })
    },
  })
}

export const useCancelWorkflowRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { workflowRunId: string; reason?: string }) =>
      apiClient.post<WorkflowRunRecord>(
        `/api/workflow-runs/${input.workflowRunId}/cancel`,
        { reason: input.reason },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.run(variables.workflowRunId),
      })
      void queryClient.invalidateQueries({ queryKey: workflowKeys.installations })
    },
  })
}

export const useRetryWorkflowRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { workflowRunId: string; reason?: string }) =>
      apiClient.post<WorkflowRunRecord>(
        `/api/workflow-runs/${input.workflowRunId}/retry`,
        { reason: input.reason },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.run(variables.workflowRunId),
      })
      void queryClient.invalidateQueries({ queryKey: workflowKeys.installations })
    },
  })
}

type StepActionInput = {
  workflowStepRunId: string
  workflowRunId: string
  reason?: string
}

export const useSkipWorkflowStepRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: StepActionInput) =>
      apiClient.post(
        `/api/workflow-step-runs/${input.workflowStepRunId}/skip`,
        { reason: input.reason },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.run(variables.workflowRunId),
      })
    },
  })
}

export const useBlockWorkflowStepRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: StepActionInput) =>
      apiClient.post(
        `/api/workflow-step-runs/${input.workflowStepRunId}/block`,
        { reason: input.reason },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.run(variables.workflowRunId),
      })
    },
  })
}

export const useUnblockWorkflowStepRun = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: StepActionInput) =>
      apiClient.post(
        `/api/workflow-step-runs/${input.workflowStepRunId}/unblock`,
        { reason: input.reason },
      ),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workflowKeys.run(variables.workflowRunId),
      })
    },
  })
}
