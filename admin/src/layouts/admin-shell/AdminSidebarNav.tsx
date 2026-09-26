import { useMemo } from 'react';
import { useFailedWorkflowRuns } from '../../facades/workflows/hooks';
import { isReactNativeWebView, requestNativeFullRefresh } from '../../lib/native-shell';
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection';
import { SidebarNavLink } from './SidebarNavLink';
import {
  ADMIN_NAV,
  isAdminNavGroupVisible,
  isAdminNavItemActive,
  isAdminNavItemVisible,
} from './admin-nav-items';
import type { AdminNavGroup, AdminNavGroupId, AdminNavViewer } from './admin-nav-items';

// Re-exported so existing call sites (e.g. `admin/test/*-nav-*.test.ts`,
// which import the nav table straight from this file) keep working without
// a path change — the data itself lives in `admin-nav-items.tsx`.
export { ADMIN_NAV, isAdminNavGroupVisible, isAdminNavItemActive, isAdminNavItemVisible };
export type { AdminNavGroup, AdminNavGroupId, AdminNavViewer };

type AdminSidebarNavProps = AdminNavViewer & {
  pathname: string;
};

const adminNavCookieName = (id: AdminNavGroupId) => `adminNavCollapsed-${id}`;

const AUTOMATIONS_PATH = '/admin/automations';

type AdminNavSectionProps = {
  group: AdminNavGroup;
  isCollapsed: boolean;
  onToggle: (id: AdminNavGroupId) => void;
  pathname: string;
  viewer: AdminNavViewer;
};

const AdminNavSection = ({
  group,
  isCollapsed,
  onToggle,
  pathname,
  viewer,
}: AdminNavSectionProps) => (
  <SidebarMenuSection
    id={`admin-nav-${group.id}`}
    isCollapsed={isCollapsed}
    onToggle={() => onToggle(group.id)}
    title={group.heading}
  >
    {group.items
      .filter((item) => isAdminNavItemVisible(item, viewer))
      .map((item) => (
        <SidebarNavLink
          active={isAdminNavItemActive(item, pathname)}
          badge={item.badgeCount
            ? { count: item.badgeCount, label: item.badgeLabel, testId: item.badgeTestId }
            : undefined}
          icon={item.icon}
          key={item.path}
          label={item.label}
          to={item.path}
        />
      ))}
  </SidebarMenuSection>
);

export const AdminSidebarNav = ({
  canManageOrganization,
  pathname,
  isAdmin,
  isOwner,
  isSuperAdmin,
  isUoaSession,
}: AdminSidebarNavProps) => {
  const nativeTouchShell = isReactNativeWebView();
  const viewer = useMemo<AdminNavViewer>(
    () => ({ canManageOrganization, isAdmin, isOwner, isSuperAdmin, isUoaSession }),
    [canManageOrganization, isAdmin, isOwner, isSuperAdmin, isUoaSession],
  );
  const visibleGroups = useMemo(
    () =>
      ADMIN_NAV.filter((group) => isAdminNavGroupVisible(group, viewer)),
    [viewer],
  );
  // A group folded by default still opens for a reader who arrives on one of
  // its pages, so the list never hides where they are standing.
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    ADMIN_NAV.map((group) => group.id),
    adminNavCookieName,
    (id) => {
      const group = ADMIN_NAV.find((candidate) => candidate.id === id);
      return Boolean(group?.collapsedByDefault)
        && !group?.items.some((item) => isAdminNavItemActive(item, pathname));
    },
  );
  // W29: the nav itself answers "did anything break?" — the count is the
  // entitlement-scoped failed-runs feed the triage column reads, beside
  // Automations, where the Workflows tab holds that column.
  const { data: failedWorkflowRuns = [] } = useFailedWorkflowRuns();
  const groupsWithBadges = useMemo(
    () =>
      visibleGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.path === AUTOMATIONS_PATH
            ? {
              ...item,
              badgeCount: failedWorkflowRuns.length,
              badgeLabel: `${failedWorkflowRuns.length} failed workflow runs`,
              badgeTestId: 'nav-workflows-failed-count',
            }
            : item,
        ),
      })),
    [failedWorkflowRuns.length, visibleGroups],
  );

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        nativeTouchShell ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <nav className="min-h-0 flex-1 overflow-y-auto py-1">
        {groupsWithBadges.map((group) => (
          <AdminNavSection
            group={group}
            isCollapsed={collapsedSections[group.id] ?? false}
            key={group.id}
            onToggle={toggleSection}
            pathname={pathname}
            viewer={viewer}
          />
        ))}
        {isReactNativeWebView() ? (
          <div className="border-t border-[color:var(--sep)] py-1">
            <button
              className="admin-sb-item"
              onClick={requestNativeFullRefresh}
              type="button"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path
                  d="M19 8a8 8 0 10.5 7M19 4v4h-4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="min-w-0 flex-1 truncate">Full refresh</span>
            </button>
          </div>
        ) : null}
      </nav>
    </aside>
  );
};
