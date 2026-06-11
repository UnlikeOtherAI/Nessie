import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { pageStatusTone } from '../../components/features/knowledge/page-status'
import { SpaceSwitcher } from '../../components/features/knowledge/SpaceSwitcher'

export const KnowledgeSidebarNav = () => {
  const {
    spaces,
    selectedSpace,
    selectedSpaceId,
    selectSpace,
    createSpace,
    createSpacePending,
    rootPages,
    openRootPage,
    openCreate,
    pagePath,
  } = useKnowledge()

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

      <SpaceSwitcher
        creating={createSpacePending}
        onCreateSpace={async (name) => {
          await createSpace(name)
        }}
        onSelect={selectSpace}
        selectedSpace={selectedSpace}
        spaces={spaces}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="flex items-center justify-between px-1 py-1">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Pages
          </span>
          <button
            aria-label="New page"
            className="admin-sidebar-plus"
            disabled={!selectedSpaceId}
            onClick={() => openCreate(null)}
            type="button"
          >
            +
          </button>
        </div>

        {!selectedSpaceId ? (
          <div className="px-2 py-8 text-center text-sm text-[color:var(--tx3)]">
            Select a space
          </div>
        ) : rootPages.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-[color:var(--tx3)]">No pages yet</div>
        ) : (
          <div className="grid gap-0.5">
            {rootPages.map((page) => (
              <button
                className={['admin-sb-item', pagePath[0] === page.id ? 'active' : ''].join(' ')}
                key={page.id}
                onClick={() => openRootPage(page.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
                <span
                  className={`text-[10px] uppercase tracking-[0.14em] ${pageStatusTone[page.status]}`}
                >
                  {page.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
