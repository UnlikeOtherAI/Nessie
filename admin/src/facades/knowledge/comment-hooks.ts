import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'

export type TextQuoteAnchor = {
  quote: string
  prefix: string
  suffix: string
  startOffset: number
}

export type AnnotationKind = 'comment' | 'note'
export type AnnotationState = 'open' | 'resolved'

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
  replies: KnowledgeAnnotationRecord[]
}

const annotationsKey = (pageId?: string, kind?: AnnotationKind) =>
  ['knowledge-annotations', pageId ?? 'none', kind ?? 'all'] as const

export const useKnowledgeAnnotations = (pageId?: string, kind?: AnnotationKind) => {
  const apiClient = useApiClient()
  return useQuery<KnowledgeAnnotationRecord[]>({
    queryKey: annotationsKey(pageId, kind),
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
    void queryClient.invalidateQueries({ queryKey: ['knowledge-annotations', pageId] })
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
