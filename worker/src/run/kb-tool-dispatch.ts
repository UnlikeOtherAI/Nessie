import {
  runKbCommentAddTool,
  runKbCommentReplyTool,
  runKbCommentResolveTool,
  runKbCommentsListTool,
  runKbDocumentComposeTool,
  runKbDocumentEditTool,
  runKbDraftWriteTool,
  runKbFileTool,
  runKbListTool,
  runKbNoteAddTool,
  runKbPageReadTool,
  runKbPublishRequestTool,
  runKbSearchTool,
} from './pa-tools.js'
import type { AgenticToolResult, BuiltinToolRuntimeContext } from './tool-types.js'
import { wrapTool } from './tool-util.js'

/**
 * Knowledge-base tool dispatch: model arguments arrive as `unknown`, so each
 * case coerces them before the handler sees them. Split out of `tools.ts` to
 * keep that dispatcher within the file-size cap; the seam is one capability
 * area, not a grab bag. Returns null when the tool is not a KB tool.
 */
export const dispatchKbTool = (
  toolName: string,
  args: Record<string, unknown>,
  context: BuiltinToolRuntimeContext,
  inputSummary: string,
): Promise<AgenticToolResult> | null => {
  switch (toolName) {
    case 'kb_comments_list':
      return wrapTool(inputSummary, () =>
        runKbCommentsListTool(context, {
          pageId: String(args.pageId ?? ''),
          kind:
            args.kind === 'comment' || args.kind === 'note' ? args.kind : undefined,
        }),
      )
    case 'kb_comment_add':
      return wrapTool(inputSummary, () =>
        runKbCommentAddTool(context, {
          pageId: String(args.pageId ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_comment_reply':
      return wrapTool(inputSummary, () =>
        runKbCommentReplyTool(context, {
          annotationId: String(args.annotationId ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_comment_resolve':
      return wrapTool(inputSummary, () =>
        runKbCommentResolveTool(context, {
          annotationId: String(args.annotationId ?? ''),
          state: args.state === 'open' ? 'open' : 'resolved',
        }),
      )
    case 'kb_note_add':
      return wrapTool(inputSummary, () =>
        runKbNoteAddTool(context, {
          pageId: String(args.pageId ?? ''),
          quote: String(args.quote ?? ''),
          body: String(args.body ?? ''),
        }),
      )
    case 'kb_search':
      return wrapTool(inputSummary, () =>
        runKbSearchTool(context, {
          query: String(args.query ?? ''),
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          limit: args.limit,
        }),
      )
    case 'kb_page_read':
      return wrapTool(inputSummary, () =>
        runKbPageReadTool(context, { pageId: String(args.pageId ?? '') }),
      )
    case 'kb_list':
      return wrapTool(inputSummary, () =>
        runKbListTool(context, {
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
        }),
      )
    case 'kb_draft_write':
      return wrapTool(inputSummary, () =>
        runKbDraftWriteTool(context, {
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
          pageId: typeof args.pageId === 'string' ? args.pageId : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          body: String(args.body ?? ''),
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
          parentPageId: typeof args.parentPageId === 'string' ? args.parentPageId : undefined,
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          changeComment: typeof args.changeComment === 'string' ? args.changeComment : undefined,
        }),
      )
    case 'kb_document_compose':
      return wrapTool(inputSummary, () =>
        runKbDocumentComposeTool(context, {
          changeComment: typeof args.changeComment === 'string' ? args.changeComment : undefined,
          labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
          markdown: typeof args.markdown === 'string' ? args.markdown : undefined,
          parentPageId: typeof args.parentPageId === 'string' ? args.parentPageId : undefined,
          spaceId: typeof args.spaceId === 'string' ? args.spaceId : undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
        }),
      )
    case 'kb_document_edit':
      return wrapTool(inputSummary, () =>
        runKbDocumentEditTool(context, {
          changeComment: typeof args.changeComment === 'string' ? args.changeComment : undefined,
          edits: Array.isArray(args.edits)
            ? args.edits.map((entry) => {
              const edit = entry as { find?: unknown; replace?: unknown }
              return {
                find: typeof edit?.find === 'string' ? edit.find : undefined,
                replace: typeof edit?.replace === 'string' ? edit.replace : undefined,
              }
            })
            : undefined,
          pageId: typeof args.pageId === 'string' ? args.pageId : undefined,
        }),
      )
    case 'kb_file':
      return wrapTool(inputSummary, () =>
        runKbFileTool(context, {
          pageId: String(args.pageId ?? ''),
          // Distinguish "omitted" (no move) from "explicit null" (move to the
          // space root) — both would otherwise collapse to undefined.
          parentPageId:
            'parentPageId' in args
              ? (typeof args.parentPageId === 'string' ? args.parentPageId : null)
              : undefined,
          position: typeof args.position === 'number' ? args.position : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
        }),
      )
    case 'kb_publish_request':
      return wrapTool(inputSummary, () =>
        runKbPublishRequestTool(context, {
          pageId: String(args.pageId ?? ''),
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        }),
      )
    default:
      return null
  }
}
