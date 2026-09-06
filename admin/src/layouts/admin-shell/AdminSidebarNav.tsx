import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useFailedWorkflowRuns } from '../../facades/workflows/hooks';
import { usePendingApprovalCount } from '../../facades/approvals/hooks';
import { isReactNativeWebView, requestNativeFullRefresh } from '../../lib/native-shell';
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection';
import { sidebarAriaCurrent } from '../../components/shared/row-a11y';
import {
  ADMIN_NAV,
  isAdminNavGroupVisible,
  isAdminNavItemActive,
  isAdminNavItemVisible,
} from './admin-nav-items';
import type { AdminNavGroup, AdminNavGroupId, AdminNavViewer } from './admin-nav-items';

// Re-exported so existing call sites (e.g. `admin/test/*-nav-*.test.ts`,
// which import the nav table straight from this file) keep working without
// a path change — the data itself now lives in `admin-nav-items.tsx`.
export { ADMIN_NAV, isAdminNavGroupVisible, isAdminNavItemActive, isAdminNavItemVisible };
export type { AdminNavGroup, AdminNavGroupId, AdminNavViewer };

type AdminSidebarNavProps = AdminNavViewer & {
  pathname: string;
};

const adminNavCookieName = (id: AdminNavGroupId) => `adminNavCollapsed-${id}`;

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
}: AdminNavSectionProps) => {
  const sectionId = `admin-nav-${group.id}`;

  return (
    <SidebarMenuSection
      id={sectionId}
      isCollapsed={isCollapsed}
      onToggle={() => onToggle(group.id)}
      title={group.heading}
    >
      {group.items
        .filter((item) => isAdminNavItemVisible(item, viewer))
        .map((item) => {
          const isActive = isAdminNavItemActive(item, pathname);
          return (
            <Link
              aria-current={sidebarAriaCurrent(isActive)}
              key={item.path}
              className={['admin-sb-item', isActive ? 'active' : ''].join(' ')}
              to={item.path}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badgeCount ? (
                <span
                  className="rounded-full bg-[color:var(--danger-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--danger-text)]"
                  data-testid={
                    item.path === '/approvals'
                      ? 'nav-approvals-pending-count'
                      : 'nav-workflows-failed-count'
                  }
                >
                  {item.badgeCount}
                </span>
              ) : null}
            </Link>
          );
        })}
    </SidebarMenuSection>
  );
};

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
  const { collapsedSections, toggleSection } = useCookieBackedSidebarSections(
    ADMIN_NAV.map((group) => group.id),
    adminNavCookieName,
  );
  // W29: the nav itself answers "did anything break?" — the count is the
  // entitlement-scoped failed-runs feed the triage column reads.
  const { data: failedWorkflowRuns = [] } = useFailedWorkflowRuns();
  const { data: pendingApprovals } = usePendingApprovalCount();
  const groupsWithBadges = useMemo(
    () =>
      visibleGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.path === '/agents/workflows'
            ? { ...item, badgeCount: failedWorkflowRuns.length }
            : item.path === '/approvals'
              ? { ...item, badgeCount: pendingApprovals?.count ?? 0 }
            : item,
        ),
      })),
    [failedWorkflowRuns.length, pendingApprovals?.count, visibleGroups],
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
