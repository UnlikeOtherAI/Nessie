import { useEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { KnowledgeDocumentPane } from '../components/features/knowledge/KnowledgeDocumentPane'
import { KnowledgeProvider, useKnowledge } from '../components/features/knowledge/KnowledgeProvider'
import { knowledgePageAncestors } from '../components/features/knowledge/page-ancestors'
import { QueryState } from '../components/shared/QueryState'
import { useKnowledgePage } from '../facades/knowledge/hooks'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { ToastProvider } from '../providers/ToastProvider'

/**
 * One document, in a window of its own.
 *
 * The desktop shell makes that window (`desktop_open_document_window`) and
 * points it at this route on the origin the main window is already signed in
 * to, which is the whole reason it arrives authenticated. Nothing here is
 * shell-only: it is an ordinary admin route, so the same URL opens in a
 * browser tab, which is where it is verified.
 *
 * There is no sidebar, no rail and no tab bar — a window holding one document
 * has nowhere else to go. What it does keep is the *same* pane the work
 * surface uses, so the document's attachments, versions, comments and editor
 * doorways are the ones the reader already knows, rather than a second
 * rendering of a document that would drift from the first.
 */

const DocumentWindowView = ({ pageId }: { pageId: string }) => {
  const {
    openPageId,
    openPagePath,
    pageById,
    pagePath,
    pagesLoadFailed,
    pagesLoading,
    popTo,
    refetchPages,
    selectedSpace,
    selectedSpaceId,
  } = useKnowledge()

  // The window opens on exactly one document. Every navigation function the
  // provider returns keeps its identity for the life of the mount, so this
  // runs on arrival and on a genuinely different page id — never on a
  // re-render.
  useEffect(() => {
    openPagePath([pageId])
  }, [openPagePath, pageId])

  const current = openPageId ? pageById(openPageId) : undefined
  const pathPages = pagePath
    .map((id) => pageById(id))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
  const depth = current ? pathPages.findIndex((page) => page.id === current.id) : -1

  // The space-pages list omits page bodies; the body is fetched for the one
  // page this window exists to show. A file node has no body to fetch.
  const fullBodyPageId = current && current.kind !== 'file' ? current.id : undefined
  const fullPageQuery = useKnowledgePage(fullBodyPageId)
  const fullPage =
    fullPageQuery.data && fullPageQuery.data.id === fullBodyPageId ? fullPageQuery.data : undefined

  // The window's own name, in the taskbar, the Window menu and the switcher.
  // The shell titles the window when it builds it; this keeps that title true
  // after a rename, and is what titles it at all on a build whose shell
  // predates the command.
  useEffect(() => {
    if (!current) return
    document.title = `${current.title} — Nessie`
  }, [current])

  return (
    <div className="h-screen w-full overflow-hidden bg-[color:var(--main)] text-[color:var(--tx)]">
      <QueryState
        className="py-16"
        // A document that has been deleted, archived out of view, or was
        // never in this space is a different fact from a fetch that failed,
        // and from one still in flight. The space is resolved by an effect on
        // the provider's first commit, so "no space yet" is still loading —
        // without that, the empty line flashes for one frame on every open.
        emptyLabel="This document isn’t here."
        errorLabel="Couldn’t load this document."
        isEmpty={!current}
        loadingLabel="Loading…"
        query={{
          isError: pagesLoadFailed,
          isLoading: pagesLoading || !selectedSpaceId,
          refetch: refetchPages,
        }}
      >
        {() =>
          current ? (
            <KnowledgeDocumentPane
              bodyQuery={fullPageQuery}
              breadcrumbPages={knowledgePageAncestors(current, pageById)}
              canWrite={selectedSpace?.canWrite ?? false}
              depth={depth}
              fullPage={fullPage}
              // Nothing to go back *to* in a window holding one document —
              // until a child is drilled into from it, which is a step this
              // window took and must be able to unwind.
              onBack={depth > 0 ? () => popTo(depth) : undefined}
              page={current}
              selectedSpaceId={selectedSpaceId}
              spaceName={selectedSpace?.name ?? 'Documents'}
            />
          ) : null
        }
      </QueryState>
    </div>
  )
}

export const DocumentWindowPage = () => {
  const { pageId, spaceId } = useParams<{ pageId: string; spaceId: string }>()
  const { me, sessionState } = useAuthSession()

  if (sessionState === 'bootstrap') return <Navigate replace to="/bootstrap" />

  if (sessionState === 'loading') {
    return (
      <main className="flex h-screen items-center justify-center bg-[color:var(--main)] px-6 text-sm text-[color:var(--tx3)]">
        Loading…
      </main>
    )
  }

  if (sessionState !== 'authenticated' || !me) return <Navigate replace to="/login" />

  // A window is only ever built with both ids; a hand-typed address that is
  // missing one belongs on the browser, not on an empty pane.
  if (!pageId || !spaceId) return <Navigate replace to="/knowledge-base" />

  return (
    <ToastProvider>
      <KnowledgeProvider spaceId={spaceId}>
        <DocumentWindowView pageId={pageId} />
      </KnowledgeProvider>
    </ToastProvider>
  )
}
