import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentTriggerRecord,
  WorkflowInstallationRecord,
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useWorkflowTemplates = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowTemplateRecord[]>({
    queryKey: ['workflow-templates'],
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
    queryKey: ['workflow-templates', workflowTemplateId],
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
      void queryClient.invalidateQueries({ queryKey: ['workflow-templates'] })
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
      void queryClient.invalidateQueries({ queryKey: ['workflow-templates'] })
      void queryClient.invalidateQueries({
        queryKey: ['workflow-templates', workflow.id],
      })
    },
  })
}

export const useWorkflowInstallations = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowInstallationRecord[]>({
    queryKey: ['workflow-installations'],
    queryFn: () => apiClient.get('/api/workflow-installations'),
    enabled,
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
      void queryClient.invalidateQueries({ queryKey: ['workflow-installations'] })
      void queryClient.invalidateQueries({ queryKey: ['workflow-templates'] })
    },
  })
}

export const useWorkflowInstallationRuns = (
  installationId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<WorkflowRunRecord[]>({
    queryKey: ['workflow-installations', installationId, 'runs'],
    queryFn: () =>
      apiClient.get(`/api/workflow-installations/${installationId}/runs`),
    enabled: enabled && Boolean(installationId),
  })
}

export const useWorkflowInstallationTriggers = (
  installationId?: string,
  enabled = true,
) => {
  const apiClient = useApiClient()

  return useQuery<AgentTriggerRecord[]>({
    queryKey: ['workflow-installations', installationId, 'triggers'],
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
    queryKey: ['workflow-runs', workflowRunId],
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
        queryKey: ['workflow-installations', variables.installationId, 'runs'],
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
        queryKey: ['workflow-runs', variables.workflowRunId],
      })
      void queryClient.invalidateQueries({ queryKey: ['workflow-installations'] })
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
        queryKey: ['workflow-runs', variables.workflowRunId],
      })
      void queryClient.invalidateQueries({ queryKey: ['workflow-installations'] })
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
        queryKey: ['workflow-runs', variables.workflowRunId],
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
        queryKey: ['workflow-runs', variables.workflowRunId],
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
        queryKey: ['workflow-runs', variables.workflowRunId],
      })
    },
  })
}
