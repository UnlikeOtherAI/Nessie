import type { ReactNode } from 'react';

/**
 * What the nav knows about the person reading it. Visibility is decided from
 * this alone — entitlement, never ambient route or session context.
 */
export type AdminNavViewer = {
  isAdmin: boolean;
  isOwner: boolean;
  isSuperAdmin: boolean;
  /** Live UOA capability (or the local-mode owner/admin fallback). */
  canManageOrganization: boolean;
  /**
   * An UnlikeOtherAI session: UOA owns membership, and the team roster
   * (`GET /api/team/members`) is entitlement-scoped to any active member
   * rather than to owners.
   */
  isUoaSession: boolean;
};

export type AdminNavItem = {
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
  /**
   * A structurally distinct route that belongs to this item but cannot be
   * expressed as a path prefix. Agent detail is `/agents/:agentId`, while the
   * other `/agents/...` paths belong to their named sibling items.
   */
  alsoActiveWhen?: (pathname: string) => boolean;
  /** W29: live count badge rendered beside the label (failed-runs triage). */
  badgeCount?: number;
};

const agentDetailRoutePrefixes = [
  '/agents/designer',
  '/agents/workflow-designer',
  '/agents/activity',
  '/agents/workflows',
  '/agents/triggers',
  '/agents/tools',
  '/agents/executors',
];

const isAgentDetailRoute = (pathname: string): boolean =>
  pathname.startsWith('/agents/')
  && !agentDetailRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export type AdminNavGroupId = 'agents' | 'user' | 'team' | 'organization' | 'governance' | 'platform';

export type AdminNavGroup = {
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
        alsoActiveWhen: isAgentDetailRoute,
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
    id: 'user',
    heading: 'User',
    items: [
      {
        path: '/settings/account',
        label: 'Settings',
        icon: icon(
          <>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" strokeLinecap="round" strokeLinejoin="round" />
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
        path: '/settings/agent-access',
        label: 'Agent access',
        icon: icon(
          <>
            <rect height="12" rx="2" width="16" x="4" y="7" />
            <path d="M9 12h.01M15 12h.01" strokeLinecap="round" />
            <path d="M12 4v3" strokeLinecap="round" />
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
    ],
  },
  {
    id: 'team',
    heading: 'Team',
    items: [
      {
        path: '/settings/team',
        label: 'Settings',
        exact: true,
        visibleTo: ({ isAdmin, isOwner }) => isOwner || isAdmin,
        icon: icon(
          <>
            <circle cx="9" cy="8" r="3" />
            <path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M16 11a3 3 0 100-6M17 20c0-2.4-.9-4.1-2.3-5" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        // Writing a team secret is owner-gated, so the doorway is too: a member
        // already sees what their team set on their own Secrets page, where it
        // is the part of the cascade that reaches them.
        path: '/settings/team/secrets',
        label: 'Secrets',
        ownerOnly: true,
        icon: icon(
          <>
            <rect height="10" rx="2" width="14" x="5" y="11" />
            <path d="M8 11V8a4 4 0 018 0v3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14v3" strokeLinecap="round" />
          </>,
        ),
      },
      {
        path: '/settings/team/members',
        label: 'Members',
        // Same shape as Organization's Members entry: on a UOA session the
        // roster read is entitlement-scoped to any active member, so
        // everyone gets the doorway and the page renders mutation controls
        // for owners/admins only. A local session keeps the owner-only page.
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
    id: 'organization',
    heading: 'Organization',
    visibleTo: ({ canManageOrganization }) => canManageOrganization,
    items: [
      {
        path: '/settings/organization',
        label: 'Settings',
        // Exact for the same reason Team's is: `/settings/organization/secrets`
        // is its own doorway and must not light this one up as well.
        exact: true,
        visibleTo: ({ canManageOrganization }) => canManageOrganization,
        icon: icon(
          <>
            <path d="M4 21V7l8-4 8 4v14" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 21v-6h6v6M9 11h.01M15 11h.01" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        // The base of the secret cascade. Owner-only for the same reason the
        // team page is: `canManageSecretScope` refuses every scope above
        // personal to anyone else.
        path: '/settings/organization/secrets',
        label: 'Secrets',
        ownerOnly: true,
        icon: icon(
          <>
            <rect height="10" rx="2" width="14" x="5" y="11" />
            <path d="M8 11V8a4 4 0 018 0v3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12 14v3" strokeLinecap="round" />
          </>,
        ),
      },
      {
        path: '/settings/members',
        label: 'Members',
        visibleTo: ({ canManageOrganization }) => canManageOrganization,
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
  return ownMatch
    || (item.alsoActiveFor ?? []).some(matchesPrefix)
    || item.alsoActiveWhen?.(pathname) === true;
};
