import { useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { faBook, faChartColumn, faLayerGroup, faUser } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { CreateSpaceDialog } from '../../components/features/knowledge/CreateSpaceDialog'
import { useKnowledge } from '../../components/features/knowledge/KnowledgeProvider'
import { KnowledgeSpaceList } from '../../components/features/knowledge/KnowledgeSpaceList'
import { StorageUsageMeter } from '../../components/features/knowledge/StorageUsageMeter'
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces'
import { useProjects } from '../../facades/projects/hooks'
import { isReactNativeWebView, usePhoneLayout } from '../../lib/mobile-shell'
import { shouldHighlightKnowledgeSidebarSelection } from './phone-navigation'
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection'

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
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    KNOWLEDGE_SECTIONS,
    sectionCookie,
  )
  const showSelectedSpace = shouldHighlightKnowledgeSidebarSelection(location.pathname, phoneLayout)

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
          <SidebarMenuSection
            className="border-b border-[color:var(--sep)] pb-1"
            id="kb-my-docs"
            isCollapsed={collapsedSections.myDocs ?? false}
            onToggle={() => toggleSection('myDocs')}
            title="My Docs"
            titleIcon={sectionIcon(faUser)}
          >
            <button
              className={[
                'admin-sb-item',
                !activeProductView && showSelectedSpace && myDocsSpace.id === selectedSpaceId ? 'active' : '',
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
            <button
              aria-label="Create space"
              className="admin-sidebar-plus"
              onClick={() => setCreateOpen(true)}
              type="button"
            >
              +
            </button>
          )}
          id="kb-spaces"
          isCollapsed={collapsedSections.spaces ?? false}
          onToggle={() => toggleSection('spaces')}
          title="Spaces"
          titleIcon={sectionIcon(faLayerGroup)}
        >
        <KnowledgeSpaceList
          emptyLabel="No spaces yet"
          onSelect={openSpace}
          projectLabels={projectLabels}
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
