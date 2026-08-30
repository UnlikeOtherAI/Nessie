import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { knowledgeKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type TextQuoteAnchor = {
  quote: string
  prefix: string
  suffix: string
  startOffset: number
}

export type AnnotationKind = 'comment' | 'note'
export type AnnotationState = 'open' | 'resolved'

export type KnowledgeAnnotationReaction = {
  id: string
  emoji: string
  userId: string | null
  agentId: string | null
  createdAt: string
}

export type KnowledgeAnnotationRecord = {
  id: string
  pageId: string
  spaceId: string
  kind: AnnotationKind
  state: AnnotationState
  parentId: string | null
  body: string
  authorType: 'user' | 'agent'
  authorId: string
  delegatedByAgentId: string | null
  anchor: TextQuoteAnchor | null
  anchorVersionId: string | null
  orphaned: boolean
  resolvedAt: string | null
  editedAt: string | null
  createdAt: string
  updatedAt: string
  reactions: KnowledgeAnnotationReaction[]
  replies: KnowledgeAnnotationRecord[]
}

export const useKnowledgeAnnotations = (pageId?: string, kind?: AnnotationKind) => {
  const apiClient = useApiClient()
  return useQuery<KnowledgeAnnotationRecord[]>({
    queryKey: knowledgeKeys.annotationsByKind(pageId, kind),
    queryFn: () =>
      apiClient.get(
        `/api/knowledge-base/pages/${pageId}/annotations${kind ? `?kind=${kind}` : ''}`,
      ),
    enabled: Boolean(pageId),
  })
}

// All annotation mutations refetch the page's annotation lists (both filtered
// and unfiltered) so comments and inline notes stay in sync after a change.
const useInvalidateAnnotations = (pageId: string) => {
  const queryClient = useQueryClient()
  return () =>
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.annotations(pageId) })
}

export const useCreateComment = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { body: string }) =>
      apiClient.post<KnowledgeAnnotationRecord>(
        `/api/knowledge-base/pages/${pageId}/comments`,
        input,
      ),
    onSuccess: invalidate,
  })
}

export const useCreateNote = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { body: string; anchor: TextQuoteAnchor; anchorVersionId: string | null }) =>
      apiClient.post<KnowledgeAnnotationRecord>(`/api/knowledge-base/pages/${pageId}/notes`, input),
    onSuccess: invalidate,
  })
}

export const useReplyAnnotation = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { annotationId: string; body: string }) =>
      apiClient.post<KnowledgeAnnotationRecord>(
        `/api/knowledge-base/annotations/${input.annotationId}/replies`,
        { body: input.body },
      ),
    onSuccess: invalidate,
  })
}

export const useSetAnnotationState = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { annotationId: string; state: AnnotationState }) =>
      apiClient.post<KnowledgeAnnotationRecord>(
        `/api/knowledge-base/annotations/${input.annotationId}/${
          input.state === 'resolved' ? 'resolve' : 'reopen'
        }`,
        {},
      ),
    onSuccess: invalidate,
  })
}

export const useEditAnnotation = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { annotationId: string; body: string }) =>
      apiClient.patch<KnowledgeAnnotationRecord>(
        `/api/knowledge-base/annotations/${input.annotationId}`,
        { body: input.body },
      ),
    onSuccess: invalidate,
  })
}

export const useDeleteAnnotation = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { annotationId: string }) =>
      apiClient.delete<{ id: string; deleted: boolean }>(
        `/api/knowledge-base/annotations/${input.annotationId}`,
      ),
    onSuccess: invalidate,
  })
}

export const useToggleAnnotationReaction = (pageId: string) => {
  const apiClient = useApiClient()
  const invalidate = useInvalidateAnnotations(pageId)
  return useMutation({
    mutationFn: (input: { annotationId: string; emoji: string }) =>
      apiClient.post<KnowledgeAnnotationRecord>(
        `/api/knowledge-base/annotations/${input.annotationId}/reactions`,
        { emoji: input.emoji },
      ),
    onSuccess: invalidate,
  })
}
