import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  AgentTodoRecord,
  AgentTodoStepStatus,
  AgentTodoTemplateRecord,
  AgentTodoTemplateStepInput,
  AgentTodoTemplateStatus,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { agentTodoKeys } from './keys'

const invalidateTemplates = (queryClient: ReturnType<typeof useQueryClient>, agentId: string) => {
  void queryClient.invalidateQueries({ queryKey: agentTodoKeys.templates(agentId, false) })
  void queryClient.invalidateQueries({ queryKey: agentTodoKeys.templates(agentId, true) })
}

export const useCreateAgentTodoTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      description?: string | null
      name: string
      status?: Exclude<AgentTodoTemplateStatus, 'archived'>
      steps: AgentTodoTemplateStepInput[]
    }) => {
      const { agentId, ...body } = input
      return apiClient.post<AgentTodoTemplateRecord>(`/api/agents/${agentId}/todo-templates`, body)
    },
    onSuccess: (_data, input) => invalidateTemplates(queryClient, input.agentId),
  })
}

export const useUpdateAgentTodoTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      description?: string | null
      name?: string
      steps?: AgentTodoTemplateStepInput[]
      templateId: string
      version: number
    }) => {
      const { agentId, templateId, ...body } = input
      return apiClient.put<AgentTodoTemplateRecord>(
        `/api/agents/${agentId}/todo-templates/${templateId}`,
        body,
      )
    },
    onSuccess: (_data, input) => invalidateTemplates(queryClient, input.agentId),
  })
}

export const useArchiveAgentTodoTemplate = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; templateId: string }) =>
      apiClient.post<AgentTodoTemplateRecord>(
        `/api/agents/${input.agentId}/todo-templates/${input.templateId}/archive`,
        {},
      ),
    onSuccess: (_data, input) => invalidateTemplates(queryClient, input.agentId),
  })
}

export const useCreateAgentTodo = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; templateId: string }) =>
      apiClient.post<AgentTodoRecord>(`/api/agents/${input.agentId}/todos`, {
        templateId: input.templateId,
      }),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: agentTodoKeys.instances(input.agentId) })
    },
  })
}

export const useUpdateAgentTodoStep = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: {
      agentId: string
      note?: string | null
      status: AgentTodoStepStatus
      stepKey: string
      todoId: string
    }) => {
      const { agentId, stepKey, todoId, ...body } = input
      return apiClient.post<AgentTodoRecord>(
        `/api/agents/${agentId}/todos/${todoId}/steps/${stepKey}`,
        body,
      )
    },
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: agentTodoKeys.instances(input.agentId) })
    },
  })
}

export const useCancelAgentTodo = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { agentId: string; todoId: string }) =>
      apiClient.post<AgentTodoRecord>(
        `/api/agents/${input.agentId}/todos/${input.todoId}/cancel`,
        {},
      ),
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: agentTodoKeys.instances(input.agentId) })
    },
  })
}
