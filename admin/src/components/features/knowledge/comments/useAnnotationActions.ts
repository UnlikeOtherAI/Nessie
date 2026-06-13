import {
  useDeleteAnnotation,
  useEditAnnotation,
  useReplyAnnotation,
  useSetAnnotationState,
  type AnnotationState,
} from '../../../../facades/knowledge/comment-hooks'

export type AnnotationActions = {
  reply: (annotationId: string, body: string) => void
  setState: (annotationId: string, state: AnnotationState) => void
  edit: (annotationId: string, body: string) => void
  remove: (annotationId: string) => void
  pending: boolean
}

// Bundles the reply/resolve/edit/delete mutations for a page so both the
// comments section and the inline-note hover card share one set of handlers.
export const useAnnotationActions = (pageId: string): AnnotationActions => {
  const replyMutation = useReplyAnnotation(pageId)
  const stateMutation = useSetAnnotationState(pageId)
  const editMutation = useEditAnnotation(pageId)
  const deleteMutation = useDeleteAnnotation(pageId)
  return {
    reply: (annotationId, body) => replyMutation.mutate({ annotationId, body }),
    setState: (annotationId, state) => stateMutation.mutate({ annotationId, state }),
    edit: (annotationId, body) => editMutation.mutate({ annotationId, body }),
    remove: (annotationId) => deleteMutation.mutate({ annotationId }),
    pending:
      replyMutation.isPending ||
      stateMutation.isPending ||
      editMutation.isPending ||
      deleteMutation.isPending,
  }
}
