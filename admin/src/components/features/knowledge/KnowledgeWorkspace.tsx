import { useEffect, useMemo, useState } from 'react'
import { ColumnBrowserColumn } from '../../shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../../shared/column-browser/ColumnBrowserViewport'
import {
  useCreateKnowledgePage,
  useCreateKnowledgeSpace,
  useKnowledgePage,
  useKnowledgePages,
  useKnowledgeSpaces,
  useKnowledgeVersions,
  usePublishKnowledgePage,
  useRestoreKnowledgeVersion,
  useUpdateKnowledgePage,
  type KnowledgePageRecord,
  type SavePageInput,
} from '../../../facades/knowledge/hooks'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { PageEditor } from './PageEditor'
import { PageTree } from './PageTree'
import { VersionHistory } from './VersionHistory'

type EditorState =
  | { mode: 'create'; parentPageId: string | null }
  | { mode: 'edit'; page: KnowledgePageRecord }
  | null

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const KnowledgeWorkspace = () => {
  const { me } = useAuthSession()
  const spacesQuery = useKnowledgeSpaces()
  const spaces = spacesQuery.data ?? []
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | undefined>()
  const [selectedPageId, setSelectedPageId] = useState<string | undefined>()
  const [editor, setEditor] = useState<EditorState>(null)
  const [spaceName, setSpaceName] = useState('')
  const [spaceError, setSpaceError] = useState<string | null>(null)

  const pagesQuery = useKnowledgePages(selectedSpaceId)
  const pages = pagesQuery.data ?? []
  const pageQuery = useKnowledgePage(selectedPageId)
  const versionsQuery = useKnowledgeVersions(selectedPageId)
  const createSpace = useCreateKnowledgeSpace()
  const createPage = useCreateKnowledgePage(selectedSpaceId)
  const updatePage = useUpdateKnowledgePage()
  const publishPage = usePublishKnowledgePage()
  const restoreVersion = useRestoreKnowledgeVersion()

  useEffect(() => {
    if (!selectedSpaceId && spaces[0]) {
      setSelectedSpaceId(spaces[0].id)
    }
  }, [selectedSpaceId, spaces])

  useEffect(() => {
    if (!selectedPageId && pages[0]) {
      setSelectedPageId(pages[0].id)
    }
  }, [pages, selectedPageId])

  const selectedPage = pageQuery.data ?? pages.find((page) => page.id === selectedPageId) ?? null
  const selectedSpace = spaces.find((space) => space.id === selectedSpaceId) ?? null
  const activeColumn = editor ? (selectedPage ? 3 : 2) : selectedPage ? 1 : 0

  const sortedSpaces = useMemo(
    () => [...spaces].sort((left, right) => left.name.localeCompare(right.name)),
    [spaces],
  )

  const createSpaceSubmit = async () => {
    if (!spaceName.trim()) {
      setSpaceError('Space name is required.')
      return
    }
    setSpaceError(null)
    const created = await createSpace.mutateAsync({
      name: spaceName.trim(),
      projectId: me?.context.projectId,
    })
    setSpaceName('')
    setSelectedSpaceId(created.id)
  }

  const savePage = async (input: SavePageInput) => {
    if (editor?.mode === 'edit') {
      await updatePage.mutateAsync({
        ...input,
        pageId: editor.page.id,
      })
      setSelectedPageId(editor.page.id)
    } else {
      const created = await createPage.mutateAsync(input)
      setSelectedPageId(created.id)
    }
    setEditor(null)
  }

  const columns = [
    <ColumnBrowserColumn
      headerAction={
        <button
          className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
          disabled={!selectedSpaceId}
          onClick={() => setEditor({ mode: 'create', parentPageId: null })}
          type="button"
        >
          New page
        </button>
      }
      key="tree"
      title="Knowledge"
    >
      <div className="grid gap-3">
        <div>
          <div className={sectionTitle}>Spaces</div>
          <div className="mt-2 grid gap-2">
            {sortedSpaces.map((space) => (
              <button
                className={[
                  'rounded-md border px-3 py-2 text-left text-sm',
                  selectedSpaceId === space.id
                    ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[var(--on-accent)]'
                    : 'border-[color:var(--sep)] text-[color:var(--tx2)] hover:bg-[var(--overlay-weak)]',
                ].join(' ')}
                key={space.id}
                onClick={() => {
                  setSelectedSpaceId(space.id)
                  setSelectedPageId(undefined)
                  setEditor(null)
                }}
                type="button"
              >
                <span className="block truncate font-semibold">{space.name}</span>
                <span className="text-[10px] uppercase tracking-[0.14em]">
                  {space.visibility}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-md border border-[color:var(--sep)] p-3">
          <div className={sectionTitle}>Create Space</div>
          <div className="mt-2 flex gap-2">
            <input
              className="admin-input min-w-0 flex-1"
              onChange={(event) => setSpaceName(event.target.value)}
              placeholder="Space name"
              value={spaceName}
            />
            <button
              className="admin-button admin-button-secondary"
              disabled={createSpace.isPending}
              onClick={() => void createSpaceSubmit()}
              type="button"
            >
              Add
            </button>
          </div>
          {spaceError ? <div className="mt-2 text-xs text-[var(--danger-text)]">{spaceError}</div> : null}
        </div>

        <div>
          <div className={sectionTitle}>Pages</div>
          {selectedSpaceId ? (
            <div className="mt-2">
              <PageTree
                onCreateChild={(parentPageId) => setEditor({ mode: 'create', parentPageId })}
                onSelectPage={(pageId) => {
                  setSelectedPageId(pageId)
                  setEditor(null)
                }}
                pages={pages}
                selectedPageId={selectedPageId}
              />
            </div>
          ) : (
            <div className="mt-6 text-center text-sm text-[color:var(--tx3)]">
              Create or select a space
            </div>
          )}
        </div>
      </div>
    </ColumnBrowserColumn>,
  ]

  if (selectedPage) {
    columns.push(
      <ColumnBrowserColumn
        headerAction={
          <div className="flex items-center gap-2">
            <button
              className="admin-button admin-button-secondary rounded-md px-3 py-1 text-xs"
              onClick={() => setEditor({ mode: 'edit', page: selectedPage })}
              type="button"
            >
              Edit
            </button>
            <button
              className="admin-button admin-button-primary rounded-md px-3 py-1 text-xs"
              disabled={publishPage.isPending}
              onClick={() => void publishPage.mutateAsync({ pageId: selectedPage.id })}
              type="button"
            >
              Publish
            </button>
          </div>
        }
        key={`page-${selectedPage.id}`}
        title={selectedPage.title}
      >
        <div className="flex h-full min-h-0 flex-col gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              <span>{selectedPage.status}</span>
              <span>{selectedPage.visibilityReason}</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold text-[var(--tx)]">{selectedPage.title}</h1>
            {selectedPage.summary ? (
              <p className="mt-2 text-sm text-[color:var(--tx2)]">{selectedPage.summary}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedPage.labels.map((label) => (
                <span
                  className="rounded bg-[var(--overlay-weak)] px-2 py-1 text-xs text-[color:var(--tx2)]"
                  key={label}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>

          <pre className="min-h-[220px] flex-1 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--sep)] p-4 text-sm text-[color:var(--tx)]">
            {selectedPage.latestVersion?.body || 'No body yet.'}
          </pre>

          <div className="rounded-md border border-[color:var(--sep)] p-3 text-xs text-[color:var(--tx3)]">
            <div>Source: {selectedPage.sourceRef}</div>
            <div>Policy: {selectedPage.policyChainTrace.join(' / ')}</div>
          </div>
        </div>
      </ColumnBrowserColumn>,
      <ColumnBrowserColumn key={`versions-${selectedPage.id}`} title="History">
        <VersionHistory
          onRestore={(versionId) =>
            void restoreVersion.mutateAsync({
              pageId: selectedPage.id,
              versionId,
              changeComment: 'Restored from admin version history',
            })
          }
          page={selectedPage}
          pending={restoreVersion.isPending}
          versions={versionsQuery.data ?? []}
        />
      </ColumnBrowserColumn>,
    )
  } else {
    columns.push(
      <ColumnBrowserColumn key="empty" title={selectedSpace?.name ?? 'Page'}>
        <div className="flex h-full items-center justify-center text-sm text-[color:var(--tx3)]">
          Select a page
        </div>
      </ColumnBrowserColumn>,
    )
  }

  if (editor) {
    columns.push(
      <ColumnBrowserColumn
        key={editor.mode === 'edit' ? `edit-${editor.page.id}` : 'create-page'}
        title={editor.mode === 'edit' ? 'Edit page' : 'Create page'}
      >
        <PageEditor
          mode={editor.mode}
          onCancel={() => setEditor(null)}
          onSubmit={savePage}
          page={editor.mode === 'edit' ? editor.page : null}
          parentPageId={editor.mode === 'create' ? editor.parentPageId : null}
          pending={createPage.isPending || updatePage.isPending}
        />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport activeColumn={activeColumn} columns={columns} />
    </div>
  )
}
