import { useAuthSession } from '../../../../providers/AuthSessionProvider'
import {
  useCreateComment,
  useKnowledgeAnnotations,
} from '../../../../facades/knowledge/comment-hooks'
import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'
import { useAnnotationActions } from './useAnnotationActions'
import { useAnnotationAuthors } from './useAnnotationAuthors'

// The page-level discussion shown below the document body: a composer plus the
// list of comments, newest first. Notes (text-anchored) are rendered inline in
// the reader, not here.
export const CommentsSection = ({ pageId }: { pageId: string }) => {
  const { me } = useAuthSession()
  const { data: comments = [] } = useKnowledgeAnnotations(pageId, 'comment')
  const createComment = useCreateComment(pageId)
  const actions = useAnnotationActions(pageId)
  const authorLabel = useAnnotationAuthors()

  return (
    <div className="mt-10 border-t border-[color:var(--sep)] pt-6">
      <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
        Comments
      </h2>
      <div className="mt-3">
        <CommentComposer
          onSubmit={(body) => createComment.mutate({ body })}
          pending={createComment.isPending}
          placeholder="Add a comment…"
          submitLabel="Comment"
        />
      </div>
      <div className="mt-4 flex flex-col gap-3">
        {comments.length === 0 ? (
          <p className="text-sm text-[color:var(--tx3)]">No comments yet.</p>
        ) : (
          comments.map((comment) => (
            <CommentThread
              actions={actions}
              annotation={comment}
              authorLabel={authorLabel}
              currentUserId={me?.user.id}
              key={comment.id}
            />
          ))
        )}
      </div>
    </div>
  )
}
