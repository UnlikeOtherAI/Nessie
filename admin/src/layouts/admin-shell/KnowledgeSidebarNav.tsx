import { useState } from 'react'
import { faLayerGroup, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces'

export const KnowledgeSidebarNav = () => {
  const {
    spaces,
    myDocsSpaceId,
    selectedSpaceId,
    selectSpace,
    activeProductView,
    selectProductView,
    createSpace,
    createSpacePending,
  } = useKnowledge()
  const { documentsSections } = useProductSurfaces()
  const [collapsed, setCollapsed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const myDocsSpace = spaces.find((space) => space.id === myDocsSpaceId)
  // The personal space is pinned above "Spaces" — never duplicated below.
  const otherSpaces = spaces.filter((space) => space.id !== myDocsSpaceId)

  return (
    <aside
      className={[
        'flex h-full w-[260px] flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
      ].join(' ')}
    >
      <div className="flex h-[50px] flex-shrink-0 items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Knowledge</span>
      </div>

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
              onClick={() => selectSpace(myDocsSpace.id)}
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
                onClick={() => selectProductView(section.view)}
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

        <div className="admin-sec-row">
          <button className="admin-sec-hdr" onClick={() => setCollapsed((value) => !value)} type="button">
            <svg
              className={[
                'h-3 w-3 text-[color:var(--tx3)] transition-transform',
                collapsed ? '-rotate-90' : '',
              ].join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Spaces
          </button>
          <button
            aria-label="Create space"
            className="admin-sidebar-plus"
            onClick={() => setCreateOpen(true)}
            type="button"
          >
            +
          </button>
        </div>

        {!collapsed &&
          (otherSpaces.length === 0 ? (
            <div className="px-4 py-3 text-sm text-[color:var(--tx3)]">No spaces yet</div>
          ) : (
            otherSpaces.map((space) => (
              <button
                className={[
                  'admin-sb-item',
                  !activeProductView && space.id === selectedSpaceId ? 'active' : '',
                ].join(' ')}
                key={space.id}
                onClick={() => selectSpace(space.id)}
                type="button"
              >
                <svg
                  className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--tx3)]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 3l9 5-9 5-9-5 9-5z" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M3 13l9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="min-w-0 flex-1 truncate">{space.name}</span>
                {space.memberAgentIds.length > 0 ? (
                  <span
                    className={[
                      'flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      'bg-[color:var(--overlay)] text-[color:var(--tx3)]',
                    ].join(' ')}
                    title={`${space.memberAgentIds.length} agent${space.memberAgentIds.length === 1 ? '' : 's'} tagged in`}
                  >
                    {space.memberAgentIds.length} agent{space.memberAgentIds.length === 1 ? '' : 's'}
                  </span>
                ) : null}
              </button>
            ))
          ))}
      </div>

      <CreateSpaceDialog
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, memberAgentIds, visibility) => {
          await createSpace(name, memberAgentIds, visibility)
        }}
        open={createOpen}
        pending={createSpacePending}
      />
    </aside>
  )
}
