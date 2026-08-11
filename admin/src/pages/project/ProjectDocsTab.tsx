import { useState } from 'react'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { KnowledgeProvider, useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { KnowledgeSpaceList } from '../../components/features/knowledge/KnowledgeSpaceList'
import { KnowledgeWorkspace } from '../../components/features/knowledge/KnowledgeWorkspace'
import { useKnowledgePageDeepLink } from '../../components/features/knowledge/useKnowledgePageDeepLink'

// The project's own documents: the same knowledge workspace the Knowledge
// section renders, scoped by KnowledgeProvider to this project. Nothing is
// duplicated — the space rail is the shared KnowledgeSpaceList and the
// document area is KnowledgeWorkspace, both driven by the scoped provider.
const ProjectDocsLayout = () => {
  const { spaces, selectedSpaceId, selectSpace, createSpace, createSpacePending } = useKnowledge()
  const [createOpen, setCreateOpen] = useState(false)

  // `?spaceId=&pageId=` — how the dashboard's Documents rows land on a document.
  useKnowledgePageDeepLink()

  return (
    <div className="flex h-full min-h-0">
      <aside
        className={[
          'flex h-full w-[208px] flex-shrink-0 flex-col overflow-hidden',
          'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        ].join(' ')}
      >
        <div className="admin-sec-row">
          <span className="admin-sec-hdr" style={{ cursor: 'default' }}>
            Spaces
          </span>
          <button
            aria-label="Create space"
            className="admin-sidebar-plus"
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            +
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <KnowledgeSpaceList
            emptyLabel="No documents filed under this project yet"
            onSelect={selectSpace}
            selectedSpaceId={selectedSpaceId}
            spaces={spaces}
          />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {selectedSpaceId ? (
          <KnowledgeWorkspace />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-[color:var(--tx3)]">
            {spaces.length === 0
              ? 'This project has no document spaces yet. Create one to file its docs here.'
              : 'Select a space to browse this project’s documents.'}
          </div>
        )}
      </div>

      <CreateSpaceDialog
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, memberAgentIds, visibility) => {
          await createSpace(name, memberAgentIds, visibility)
        }}
        open={createOpen}
        pending={createSpacePending}
      />
    </div>
  )
}

export const ProjectDocsTab = ({ projectId }: { projectId: string }) => (
  <KnowledgeProvider projectId={projectId}>
    <ProjectDocsLayout />
  </KnowledgeProvider>
)
