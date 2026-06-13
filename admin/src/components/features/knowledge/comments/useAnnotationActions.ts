import {
  useDeleteAnnotation,
  useEditAnnotation,
  useReplyAnnotation,
  useSetAnnotationState,
  useToggleAnnotationReaction,
  type AnnotationState,
} from '../../../../facades/knowledge/comment-hooks'

export type AnnotationActions = {
  // reply/edit are awaitable so the composer can keep typed text + surface an
  // error when they fail, and only close/clear on success.
  reply: (annotationId: string, body: string) => Promise<unknown>
  setState: (annotationId: string, state: AnnotationState) => void
  edit: (annotationId: string, body: string) => Promise<unknown>
  remove: (annotationId: string) => void
  toggleReaction: (annotationId: string, emoji: string) => void
  pending: boolean
}

// Bundles the reply/resolve/edit/delete/react mutations for a page so both the
// comments section and the inline-note hover card share one set of handlers.
export const useAnnotationActions = (pageId: string): AnnotationActions => {
  const replyMutation = useReplyAnnotation(pageId)
  const stateMutation = useSetAnnotationState(pageId)
  const editMutation = useEditAnnotation(pageId)
  const deleteMutation = useDeleteAnnotation(pageId)
  const reactionMutation = useToggleAnnotationReaction(pageId)
  return {
    reply: (annotationId, body) => replyMutation.mutateAsync({ annotationId, body }),
    setState: (annotationId, state) => stateMutation.mutate({ annotationId, state }),
    edit: (annotationId, body) => editMutation.mutateAsync({ annotationId, body }),
    remove: (annotationId) => deleteMutation.mutate({ annotationId }),
    toggleReaction: (annotationId, emoji) =>
      reactionMutation.mutate({ annotationId, emoji }),
    pending:
      replyMutation.isPending ||
      stateMutation.isPending ||
      editMutation.isPending ||
      deleteMutation.isPending,
  }
}
