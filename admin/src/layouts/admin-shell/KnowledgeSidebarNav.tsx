import { useState } from 'react'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'

export const KnowledgeSidebarNav = () => {
  const { spaces, selectedSpaceId, selectSpace, createSpace, createSpacePending } = useKnowledge()
  const [collapsed, setCollapsed] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <aside
      className={[
        'hidden h-full w-[260px] flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)] md:flex',
      ].join(' ')}
    >
      <div className="flex h-[50px] flex-shrink-0 items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Knowledge</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
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
          (spaces.length === 0 ? (
            <div className="px-4 py-3 text-sm text-[color:var(--tx3)]">No spaces yet</div>
          ) : (
            spaces.map((space) => (
              <button
                className={['admin-sb-item', space.id === selectedSpaceId ? 'active' : ''].join(' ')}
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
              </button>
            ))
          ))}
      </div>

      <CreateSpaceDialog
        onClose={() => setCreateOpen(false)}
        onCreate={async (name) => {
          await createSpace(name)
        }}
        open={createOpen}
        pending={createSpacePending}
      />
    </aside>
  )
}
