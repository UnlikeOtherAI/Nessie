import { useCallback } from 'react'
import type { KnowledgePageRecord } from '../../../facades/knowledge/hooks'
import { openDocumentWindow, opensDocumentsInTheirOwnWindow } from '../../../lib/document-window'

/**
 * The one place a Finder row's "open this document" decides where the document
 * goes: the pane beside the browser on the web and on a phone, a window of its
 * own on the desktop shell.
 *
 * Every caller hands in the in-place open it would have done. That is not a
 * courtesy — it is the fallback the shell needs: a desktop build older than
 * the `desktop_open_document_window` command answers with an error, and the
 * document still has to open.
 *
 * Folders are not routed through here. A folder is a move inside the browser,
 * not a thing that opens, and on the desktop it keeps its one tap the way
 * macOS Finder's own columns view does.
 */
export const useOpenDocument = (): ((
  page: Pick<KnowledgePageRecord, 'id' | 'spaceId' | 'title'>,
  openInPlace: () => void,
) => void) =>
  useCallback((page, openInPlace) => {
    if (!opensDocumentsInTheirOwnWindow()) {
      openInPlace()
      return
    }
    void openDocumentWindow({
      pageId: page.id,
      spaceId: page.spaceId,
      title: page.title,
    }).then((opened) => {
      if (!opened) openInPlace()
    })
  }, [])
