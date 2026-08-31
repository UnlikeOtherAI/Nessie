import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { DebugTokenButton } from '../../components/shared/DebugTokenButton';
import { useFailedWorkflowRuns } from '../../facades/workflows/hooks';
import { isReactNativeWebView, requestNativeFullRefresh } from '../../lib/mobile-shell';
import { SidebarMenuSection, useCookieBackedSidebarSections } from './SidebarMenuSection';

/**
 * What the nav knows about the person reading it. Visibility is decided from
 * this alone — entitlement, never ambient route or session context.
 */
export type AdminNavViewer = {
  isAdmin: boolean;
  isOwner: boolean;
  isSuperAdmin: boolean;
  /**
   * An UnlikeOtherAI session: UOA owns membership, and the workspace roster
   * (`GET /api/workspace/members`) is entitlement-scoped to any active member
   * rather than to owners.
   */
  isUoaSession: boolean;
};

type AdminSidebarNavProps = AdminNavViewer & {
  pathname: string;
};

type AdminNavItem = {
  path: string;
  label: string;
  icon: ReactNode;
  ownerOnly?: boolean;
  /**
   * The item's own entitlement rule, for the few pages whose audience is not
   * "owner" or "everybody". Replaces `ownerOnly` when present; `ownerOnly` is
   * the shorthand for the common case.
   */
  visibleTo?: (viewer: AdminNavViewer) => boolean;
  exact?: boolean;
  /**
   * Extra route prefixes that also light this item up. The Agents entry owns
   * the agent designer (`/agents/designer[/:id]`) — reached by New agent / Edit
   * — so editing an agent keeps "Agents" active rather than lighting a separate
   * item. Each entry matches its own path or `${path}/…`.
   */
  alsoActiveFor?: string[];
  /** W29: live count badge rendered beside the label (failed-runs triage). */
  badgeCount?: number;
};

type AdminNavGroupId = 'agents' | 'account' | 'organization' | 'governance' | 'platform';

type AdminNavGroup = {
  id: AdminNavGroupId;
  heading: string;
  /**
   * A section may host items with distinct, non-overlapping audiences. Its
   * visibility must therefore be explicit rather than inherited from the
   * narrowest item inside it.
   */
  visibleTo?: (viewer: AdminNavViewer) => boolean;
  items: AdminNavItem[];
};

const icon = (path: ReactNode) => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    {path}
  </svg>
);

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    id: 'agents',
    heading: 'Agents',
    items: [
      {
        path: '/agents',
        label: 'Agents',
        exact: true,
        alsoActiveFor: ['/agents/designer'],
        icon: icon(
          <>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/agents/workflows',
        label: 'Workflows',
        icon: icon(
          <>
            <rect height="4" rx="1" width="6" x="4" y="4" />
            <rect height="4" rx="1" width="6" x="14" y="10" />
            <rect height="4" rx="1" width="6" x="4" y="16" />
            <path d="M10 6h2a2 2 0 012 2v4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 12h-2a2 2 0 00-2 2v4" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/agents/triggers',
        label: 'Triggers',
        icon: icon(
          <>
            <path d="M12 4v6M12 16v4M20 12h-4M8 12H4" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3.5" />
          </>,
        ),
      },
      {
        path: '/agents/tools',
        label: 'Tools',
        ownerOnly: true,
        icon: icon(
          <path
            d="M14.7 6.3a4 4 0 105 5l-6.9 6.9a2 2 0 11-2.8-2.8l6.9-6.9a4 4 0 00-2.2-2.2z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />,
        ),
      },
      {
        path: '/agents/executors',
        label: 'Executors',
        icon: icon(
          <>
            <rect height="12" rx="2" width="16" x="4" y="6" />
            <path d="M8 10h.01M12 10h4M8 14h8" strokeLinecap="round" />
          </>,
        ),
      },
      {
        // The App Store: the member-facing face of the connector catalogue.
        // `exact: false` would light this on `/apps/:slug` anyway, which is
        // what we want — the detail page belongs to Apps.
        path: '/apps',
        label: 'Apps',
        icon: icon(
          <>
            <rect height="7" rx="2" width="7" x="3" y="3" />
            <rect height="7" rx="2" width="7" x="14" y="3" />
            <rect height="7" rx="2" width="7" x="3" y="14" />
            <path d="M17.5 14v7M14 17.5h7" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
    ],
  },
  {
    id: 'account',
    heading: 'Account',
    items: [
      {
        path: '/settings/profile',
        label: 'Profile & Session',
        icon: icon(
          <>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/security',
        label: 'Security',
        icon: icon(
          <>
            <rect height="10" rx="2" width="14" x="5" y="11" />
            <path d="M8 11V8a4 4 0 018 0v3" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/secrets',
        label: 'Secrets',
        icon: icon(
          <>
            <rect height="10" rx="2" width="14" x="5" y="11" />
            <path d="M8 11V8a4 4 0 018 0v3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14v3" strokeLinecap="round" />
          </>,
        ),
      },
      {
        path: '/settings/notifications',
        label: 'Notifications',
        icon: icon(
          <>
            <path
              d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M13.7 21a2 2 0 01-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/connections',
        label: 'Connected accounts',
        icon: icon(
          <>
            <path
              d="M9 12a3 3 0 013-3h2a3 3 0 010 6h-1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M15 12a3 3 0 01-3 3h-2a3 3 0 010-6h1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>,
        ),
      },
      {
        path: '/settings/integrations',
        label: 'Integrations',
        icon: icon(
          <>
            <path d="M8 7h4a3 3 0 010 6H8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M16 17h-4a3 3 0 010-6h4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 7h3M18 17h3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 4v6M18 14v6" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/statuses',
        label: 'Statuses',
        icon: icon(
          <>
            <circle cx="8" cy="8" r="3" />
            <path d="M4 20c0-3 1.8-5 4-5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14 6h6M14 11h4M14 16h6" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/appearance',
        label: 'Appearance',
        icon: icon(
          <>
            <circle cx="12" cy="12" r="4" />
            <path
              d="M12 3v2M12 19v2M3 12h2M19 12h2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>,
        ),
      },
    ],
  },
  {
    id: 'organization',
    heading: 'Organization',
    items: [
      {
        path: '/settings/organization',
        label: 'General',
        visibleTo: ({ isAdmin, isOwner }) => isOwner || isAdmin,
        icon: icon(
          <>
            <path d="M4 21V7l8-4 8 4v14" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 21v-6h6v6M9 11h.01M15 11h.01" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/members',
        label: 'Members',
        // On a UOA session the roster read is entitlement-scoped to any active
        // member, so everyone gets the doorway and the page renders the
        // mutation controls for owners/admins only. A local session keeps the
        // owner-only page (local create/role controls), so the nav follows.
        visibleTo: ({ isOwner, isUoaSession }) => isUoaSession || isOwner,
        icon: icon(
          <>
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19c0-3 2.46-5 5.5-5s5.5 2 5.5 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M16 5.2a3 3 0 010 5.6M18 19c0-2.2-.9-4-2.4-5" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
    ],
  },
  {
    // Member-reachable: any member can act on Approvals they are entitled to and
    // read their team's Credits & billing. The owner-only surfaces live in Ops.
    id: 'governance',
    heading: 'Governance',
    items: [
      {
        path: '/approvals',
        label: 'Approvals',
        icon: icon(<path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />),
      },
      {
        path: '/tokens',
        label: 'Credits & billing',
        icon: icon(
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v8M9.5 10.5h3.5a1.5 1.5 0 010 3H9.5" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
    ],
  },
  {
    // Platform now owns both deployment administration and the organisation
    // operational controls. Individual item gates preserve the two audiences:
    // an owner sees the three organisation-scoped controls, while a deployment
    // super-admin sees Health and Push credentials.
    id: 'platform',
    heading: 'Platform',
    visibleTo: ({ isOwner, isSuperAdmin }) => isOwner || isSuperAdmin,
    items: [
      {
        path: '/ops',
        label: 'Health',
        exact: true,
        // Deployment-wide infrastructure (worker heartbeat, queue, dead jobs).
        // `GET /api/ops/health` requires `User.superAdmin`.
        visibleTo: (viewer) => viewer.isSuperAdmin,
        icon: icon(
          <path d="M3 12h4l2 6 4-12 2 6h6" strokeLinecap="round" strokeLinejoin="round" />,
        ),
      },
      {
        path: '/settings/push',
        label: 'Push credentials',
        visibleTo: (viewer) => viewer.isSuperAdmin,
        icon: icon(
          <>
            <circle cx="8" cy="8" r="3.5" />
            <path
              d="M10.6 10.6L20 20M16.5 16.5l2-2M18.5 18.5l1.5-1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>,
        ),
      },
      {
        path: '/audit',
        label: 'Audit log',
        ownerOnly: true,
        icon: icon(
          <>
            <path d="M6 3h9l3 3v15H6z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 9h6M9 13h6M9 17h4" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/policy',
        label: 'Policy',
        ownerOnly: true,
        icon: icon(
          <path
            d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />,
        ),
      },
      {
        path: '/ops/usage',
        label: 'Operational usage',
        ownerOnly: true,
        icon: icon(
          <>
            <path d="M4 19V9M10 19V5M16 19v-7M22 19V3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 19h22" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
    ],
  },
];

const adminNavCookieName = (id: AdminNavGroupId) => `adminNavCollapsed-${id}`;

/** One gate for every item: its own rule when it has one, else `ownerOnly`. */
export const isAdminNavItemVisible = (item: AdminNavItem, viewer: AdminNavViewer): boolean =>
  item.visibleTo ? item.visibleTo(viewer) : !item.ownerOnly || viewer.isOwner;

export const isAdminNavGroupVisible = (group: AdminNavGroup, viewer: AdminNavViewer): boolean =>
  group.visibleTo?.(viewer) ?? true;

/**
 * Whether `pathname` lights up this item: its own path (exact or prefix) or any
 * of its `alsoActiveFor` prefixes. So `/agents/designer/:id` keeps "Agents"
 * active rather than a separate Designer entry.
 */
export const isAdminNavItemActive = (item: AdminNavItem, pathname: string): boolean => {
  const matchesPrefix = (path: string) =>
    pathname === path || pathname.startsWith(`${path}/`);
  const ownMatch = item.exact ? pathname === item.path : matchesPrefix(item.path);
  return ownMatch || (item.alsoActiveFor ?? []).some(matchesPrefix);
};

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
              key={item.path}
              className={['admin-sb-item', isActive ? 'active' : ''].join(' ')}
              to={item.path}
            >
              {item.icon}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.badgeCount ? (
                <span
                  className="rounded-full bg-[color:var(--danger-soft)] px-1.5 py-0.5 text-[10px] font-semibold text-[color:var(--danger-text)]"
                  data-testid="nav-workflows-failed-count"
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
  pathname,
  isAdmin,
  isOwner,
  isSuperAdmin,
  isUoaSession,
}: AdminSidebarNavProps) => {
  const nativeTouchShell = isReactNativeWebView();
  const viewer = useMemo<AdminNavViewer>(
    () => ({ isAdmin, isOwner, isSuperAdmin, isUoaSession }),
    [isAdmin, isOwner, isSuperAdmin, isUoaSession],
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
  const groupsWithBadges = useMemo(
    () =>
      visibleGroups.map((group) => ({
        ...group,
        items: group.items.map((item) =>
          item.path === '/agents/workflows'
            ? { ...item, badgeCount: failedWorkflowRuns.length }
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
            <DebugTokenButton variant="sidebar" />
            <button
              className="admin-sb-item"
              onClick={requestNativeFullRefresh}
              type="button"
            >
              {icon(
                <path
                  d="M19 8a8 8 0 10.5 7M19 4v4h-4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />,
              )}
              <span className="min-w-0 flex-1 truncate">Full refresh</span>
            </button>
          </div>
        ) : null}
      </nav>
    </aside>
  );
};
