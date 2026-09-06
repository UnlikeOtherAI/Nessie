import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateFeedbackRequest, FeedbackRecord } from '../../lib/api-client'
import { feedbackKeys } from './keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export const useFeedback = () => {
  const apiClient = useApiClient()

  return useQuery<FeedbackRecord[]>({
    queryKey: feedbackKeys.all,
    queryFn: () => apiClient.get('/api/feedback'),
  })
}

export const useCreateFeedback = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateFeedbackRequest) =>
      apiClient.post<FeedbackRecord>('/api/feedback', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: feedbackKeys.all })
    },
  })
}
