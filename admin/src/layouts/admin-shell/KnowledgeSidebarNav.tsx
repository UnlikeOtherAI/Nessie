import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { faLayerGroup, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { KnowledgeSpaceList } from '../../components/features/knowledge/KnowledgeSpaceList'
import { StorageUsageMeter } from '../../components/features/knowledge/StorageUsageMeter'
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces'
import { useProjects } from '../../facades/projects/hooks'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'

export const KnowledgeSidebarNav = () => {
  const navigate = useNavigate()
  const nativeTouchShell = isReactNativeWebView()
  const phoneLayout = usePhoneLayout()
  const {
    spaces,
    myDocsSpaceId,
    selectedSpaceId,
    scopeProjectId,
    selectSpace,
    activeProductView,
    selectProductView,
    createSpace,
    createSpacePending,
  } = useKnowledge()
  const { documentsSections } = useProductSurfaces()
  const { data: projects = [] } = useProjects()
  const [createOpen, setCreateOpen] = useState(false)

  const openSpace = (spaceId: string) => {
    selectSpace(spaceId)
    if (phoneLayout) {
      void navigate(`/knowledge-base/spaces/${encodeURIComponent(spaceId)}`)
    }
  }

  const openProductView = (view: string) => {
    selectProductView(view)
    if (phoneLayout) {
      void navigate(`/knowledge-base/views/${encodeURIComponent(view)}`)
    }
  }

  const myDocsSpace = spaces.find((space) => space.id === myDocsSpaceId)
  // The personal space is pinned above "Spaces" — never duplicated below.
  const otherSpaces = spaces.filter((space) => space.id !== myDocsSpaceId)

  // This list is organization-wide, so two projects that each seeded a
  // "General" space render as two identical rows. Name the project on every
  // row as soon as the list spans more than one — and never when it doesn't,
  // where it would just repeat the same word down the column.
  const projectLabels = useMemo(() => {
    const distinct = new Set(otherSpaces.map((space) => space.projectId))
    if (distinct.size < 2) return undefined
    return Object.fromEntries(projects.map((project) => [project.id, project.name]))
  }, [otherSpaces, projects])

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {myDocsSpace ? (
          <div className="border-b border-[color:var(--sep)] pb-1">
            <div className="admin-sec-row">
              <span className="admin-sec-hdr" style={{ cursor: 'default' }}>
                My Docs
              </span>
            </div>
            <button
              className={[
                'admin-sb-item',
                !activeProductView && myDocsSpace.id === selectedSpaceId ? 'active' : '',
              ].join(' ')}
              onClick={() => openSpace(myDocsSpace.id)}
              type="button"
            >
              <FontAwesomeIcon
                className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--accent)]"
                fixedWidth
                icon={faUser}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{myDocsSpace.name}</span>
            </button>
          </div>
        ) : null}

        {documentsSections.length > 0 ? (
          <div className="border-b border-[color:var(--sep)] pb-1">
            {documentsSections.map((section) => (
              <button
                className={[
                  'admin-sb-item',
                  activeProductView === section.view ? 'active' : '',
                ].join(' ')}
                key={section.productSlug + section.view}
                onClick={() => openProductView(section.view)}
                type="button"
              >
                <FontAwesomeIcon
                  className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--accent)]"
                  fixedWidth
                  icon={faLayerGroup}
                />
                <span className="min-w-0 flex-1 truncate font-medium">{section.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* A plain label, not a collapsible group: space rows never expand
            (the page tree lives in the main area), this is the only group
            below the pinned sections, and the collapse was component state
            that reset on every navigation — unlike the channels sidebar,
            which persists its own. It hosts the create action, nothing more. */}
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

        <KnowledgeSpaceList
          emptyLabel="No spaces yet"
          onSelect={openSpace}
          projectLabels={projectLabels}
          selectedSpaceId={activeProductView ? undefined : selectedSpaceId}
          spaces={otherSpaces}
        />
      </div>

      {/* Storage is organization-wide context, not a per-space action. Keeping
          it in the global Knowledge sidebar makes that scope clear and leaves
          the shared page header room for actions on a narrow project tab. */}
      {!scopeProjectId ? (
        <div className="border-t border-[color:var(--sep)] px-4 py-3">
          <StorageUsageMeter />
        </div>
      ) : null}

      <CreateSpaceDialog
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, memberAgentIds, visibility) => {
          const created = await createSpace(name, memberAgentIds, visibility)
          if (phoneLayout) {
            void navigate(`/knowledge-base/spaces/${encodeURIComponent(created.id)}`)
          }
        }}
        open={createOpen}
        pending={createSpacePending}
      />
    </aside>
  )
}
