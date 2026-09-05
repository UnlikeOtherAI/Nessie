import { useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { faBook, faChartColumn, faLayerGroup, faPlus, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { KnowledgeSpaceList } from '../../components/features/knowledge/KnowledgeSpaceList'
import { KnowledgeSidebarPageTree } from '../../components/features/knowledge/KnowledgeSidebarPageTree'
import { StorageUsageMeter } from '../../components/features/knowledge/StorageUsageMeter'
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces'
import { useProjects } from '../../facades/projects/hooks'
import { useScrollMemory } from '../../hooks/useScrollMemory'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import {
  resolveKnowledgeSidebarSelectionPath,
  shouldHighlightKnowledgeSidebarSelection,
} from './phone-navigation'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'
import { SidebarIconButton } from './SidebarIcons'
import { sidebarAriaCurrent } from './SidebarRow'

// Same cookie-backed persistence the channels, projects and admin rails use.
// The previous plain-label version was deliberate — collapse state was
// component state that reset on every navigation — so adopting the shared
// hook is what makes collapsing worth having here.
const KNOWLEDGE_SECTIONS = ['myDocs', 'dashboards', 'products', 'spaces'] as const
const sectionCookie = (id: (typeof KNOWLEDGE_SECTIONS)[number]) => `nessie.sb.kb.${id}`

const sectionIcon = (icon: typeof faUser) => (
  <FontAwesomeIcon
    className="h-3 w-3 flex-shrink-0 text-[color:var(--tx3)]"
    fixedWidth
    icon={icon}
  />
)

export const KnowledgeSidebarNav = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const nativeTouchShell = isReactNativeWebView()
  const phoneLayout = usePhoneLayout()
  const {
    spaces,
    spacePagination,
    spacesLoaded,
    spacesLoadFailed,
    rootPages,
    childrenOf,
    openPageId,
    openPagePath,
    myDocsSpace,
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
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    KNOWLEDGE_SECTIONS,
    sectionCookie,
  )
  const showSelectedSpace = shouldHighlightKnowledgeSidebarSelection(location.pathname, phoneLayout)

  const openSpace = (spaceId: string) => {
    selectSpace(spaceId)
    void navigate(resolveKnowledgeSidebarSelectionPath({ id: spaceId, type: 'space' }))
  }

  const openProductView = (view: string) => {
    selectProductView(view)
    void navigate(resolveKnowledgeSidebarSelectionPath({ id: view, type: 'view' }))
  }

  const openPage = (spaceId: string, path: string[]) => {
    if (selectedSpaceId !== spaceId) selectSpace(spaceId)
    openPagePath(path)
    if (phoneLayout) {
      void navigate(`/knowledge-base/spaces/${encodeURIComponent(spaceId)}`)
    }
  }

  const selectedPageTree = (spaceId: string) => (
    <KnowledgeSidebarPageTree
      activePageId={showSelectedSpace ? openPageId : undefined}
      childrenOf={childrenOf}
      onSelect={(path) => openPage(spaceId, path)}
      rootPages={rootPages}
    />
  )

  // The personal space is fetched through its own stable endpoint and omitted
  // from the paged shared list, so its pin never depends on the current page.
  const otherSpaces = spaces

  // This list is organization-wide, so two projects that each seeded a
  // "General" space render as two identical rows. Name the project on every
  // row as soon as the list spans more than one — and never when it doesn't,
  // where it would just repeat the same word down the column.
  const projectLabels = useMemo(() => {
    const distinct = new Set(otherSpaces.map((space) => space.projectId))
    if (distinct.size < 2) return undefined
    return Object.fromEntries(projects.map((project) => [project.id, project.name]))
  }, [otherSpaces, projects])

  // Shared across every route in the Knowledge section, so its position only
  // needs to survive it swapping out for another section's sidebar and back
  // — a constant key, not a per-route one (docs/navigation/overview.md §4.13).
  const treeScroll = useScrollMemory('sidebar:knowledge-tree')

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <div
        className="min-h-0 flex-1 overflow-y-auto py-1"
        onScroll={treeScroll.onScroll}
        ref={treeScroll.ref}
      >
        {myDocsSpace ? (
          <SidebarMenuSection
            className="border-b border-[color:var(--sep)] pb-1"
            id="kb-my-docs"
            isCollapsed={collapsedSections.myDocs ?? false}
            onToggle={() => toggleSection('myDocs')}
            title="My Docs"
            titleIcon={sectionIcon(faUser)}
          >
            <button
              aria-current={sidebarAriaCurrent(
                Boolean(
                  !activeProductView
                  && showSelectedSpace
                  && myDocsSpace.id === selectedSpaceId
                  && !openPageId,
                ),
              )}
              className={[
                'admin-sb-item',
                !activeProductView && showSelectedSpace && myDocsSpace.id === selectedSpaceId
                  ? openPageId ? 'active-parent' : 'active'
                  : '',
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
            {!activeProductView && showSelectedSpace && myDocsSpace.id === selectedSpaceId
              ? selectedPageTree(myDocsSpace.id)
              : null}
          </SidebarMenuSection>
        ) : null}

        {/* Dashboards sit inside Knowledge, between the personal docs and the
            shared spaces: a dashboard is something you read, filed with the
            other things you read, rather than a section of its own. This also
            makes it reachable on mobile, whose native tab bar has a Knowledge
            tab and no room for another. */}
        <SidebarMenuSection
          className="border-b border-[color:var(--sep)] pb-1"
          id="kb-dashboards"
          isCollapsed={collapsedSections.dashboards ?? false}
          onToggle={() => toggleSection('dashboards')}
          title="Dashboards"
          titleIcon={sectionIcon(faChartColumn)}
        >
          <NavLink
            className={({ isActive }) => ['admin-sb-item', isActive ? 'active' : ''].join(' ')}
            to="/dashboards"
          >
            <FontAwesomeIcon
              className="h-3.5 w-3.5 flex-shrink-0 text-[color:var(--accent)]"
              fixedWidth
              icon={faChartColumn}
            />
            <span className="min-w-0 flex-1 truncate font-medium">All dashboards</span>
          </NavLink>
        </SidebarMenuSection>

        {documentsSections.length > 0 ? (
          <SidebarMenuSection
            className="border-b border-[color:var(--sep)] pb-1"
            id="kb-products"
            isCollapsed={collapsedSections.products ?? false}
            onToggle={() => toggleSection('products')}
            title="Product docs"
            titleIcon={sectionIcon(faBook)}
          >
            {documentsSections.map((section) => (
              <button
                aria-current={sidebarAriaCurrent(activeProductView === section.view)}
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
          </SidebarMenuSection>
        ) : null}

        <SidebarMenuSection
          action={(
            <SidebarIconButton
              aria-label="Create space"
              icon={faPlus}
              onClick={() => setCreateOpen(true)}
              placement="section"
            />
          )}
          id="kb-spaces"
          isCollapsed={collapsedSections.spaces ?? false}
          onToggle={() => toggleSection('spaces')}
          title="Spaces"
          titleIcon={sectionIcon(faLayerGroup)}
        >
          <KnowledgeSpaceList
            emptyLabel="No spaces yet"
            isPending={!spacesLoaded && !spacesLoadFailed}
            onSelect={openSpace}
            pagination={spacePagination}
            projectLabels={projectLabels}
            renderAfter={(space) => selectedPageTree(space.id)}
            selectedPageId={showSelectedSpace ? openPageId : undefined}
            selectedSpaceId={activeProductView || !showSelectedSpace ? undefined : selectedSpaceId}
            spaces={otherSpaces}
          />
        </SidebarMenuSection>
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
          void navigate(resolveKnowledgeSidebarSelectionPath({ id: created.id, type: 'space' }))
        }}
        open={createOpen}
        pending={createSpacePending}
      />
    </aside>
  )
}
