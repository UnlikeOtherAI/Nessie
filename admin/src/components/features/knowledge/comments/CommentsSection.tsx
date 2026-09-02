import type { RefObject } from 'react'
import { useOptionalAuthSession } from '../../../../providers/AuthSessionProvider'
import {
  useCreateComment,
  useKnowledgeAnnotations,
} from '../../../../facades/knowledge/comment-hooks'
import { SectionLabel } from '../../../primitives/SectionLabel'
import { CommentComposer } from './CommentComposer'
import { CommentThread } from './CommentThread'
import { useAnnotationActions } from './useAnnotationActions'
import { useAnnotationAuthors } from './useAnnotationAuthors'

// The page-level discussion shown below the document body: a composer plus the
// list of comments, newest first. Notes (text-anchored) are rendered inline in
// the reader, not here.
export const CommentsSection = ({
  canResolve,
  composerRef,
  pageId,
}: {
  // Resolving/reopening changes shared page state and requires write access.
  // Creating, replying, reacting, and editing one's own comment require only
  // the read access already established by the containing page.
  canResolve: boolean
  composerRef?: RefObject<HTMLTextAreaElement | null>
  pageId: string
}) => {
  const me = useOptionalAuthSession()?.me ?? null
  const { data: comments = [] } = useKnowledgeAnnotations(pageId, 'comment')
  const createComment = useCreateComment(pageId)
  const actions = useAnnotationActions(pageId)
  const authorLabel = useAnnotationAuthors()

  return (
    <div className="mt-10 border-t border-[color:var(--sep)] pt-6">
      <SectionLabel as="h2" size="2xs">Comments</SectionLabel>
      <div className="mt-3">
        <CommentComposer
          onSubmit={(body) => createComment.mutateAsync({ body })}
          pending={createComment.isPending}
          placeholder="Add a comment…"
          submitLabel="Comment"
          textareaRef={composerRef}
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
              canResolve={canResolve}
              currentUserId={me?.user.id}
              key={comment.id}
            />
          ))
        )}
      </div>
    </div>
  )
}
