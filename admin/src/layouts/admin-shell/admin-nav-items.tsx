import type { ReactNode } from 'react';
import {
  announcementsIcon,
  appsIcon,
  automationsIcon,
  computerIcon,
  connectionsIcon,
  creditsIcon,
  debugIcon,
  healthIcon,
  keyIcon,
  modelsIcon,
  organizationIcon,
  peopleIcon,
  personIcon,
  pushIcon,
  rulesIcon,
  shieldIcon,
  teamsIcon,
  toolIcon,
  usageIcon,
} from './nav-icons';

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
   * The item's own entitlement rule, for the pages whose audience is not
   * "owner" or "everybody". Replaces `ownerOnly` when present; `ownerOnly` is
   * the shorthand for the common case.
   */
  visibleTo?: (viewer: AdminNavViewer) => boolean;
  /** Caller-scoped work that needs attention, rendered beside the label. */
  badgeCount?: number;
  badgeLabel?: string;
  badgeTestId?: string;
};

export type AdminNavGroupId = 'agents' | 'organisation' | 'advanced';

export type AdminNavGroup = {
  id: AdminNavGroupId;
  heading: string;
  /** Folded shut until the reader opens it (the choice then persists). */
  collapsedByDefault?: boolean;
  /**
   * A group may host items with distinct, non-overlapping audiences. When it
   * says nothing, it renders whenever any of its items is visible to the
   * reader; a rule here replaces that.
   */
  visibleTo?: (viewer: AdminNavViewer) => boolean;
  items: AdminNavItem[];
};

const ownerOrAdmin = ({ isAdmin, isOwner }: AdminNavViewer): boolean => isOwner || isAdmin;

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    // Everyone's: the agents they can use, and what agents use. A member opens
    // Admin and lands here.
    id: 'agents',
    heading: 'Agents',
    items: [
      { path: '/admin/agents', label: 'Agents', icon: personIcon },
      { path: '/admin/apps', label: 'Apps', icon: appsIcon },
      { path: '/admin/computers', label: 'Computers', icon: computerIcon },
      { path: '/admin/automations', label: 'Automations', icon: automationsIcon },
    ],
  },
  {
    // The organisation's administration. The group renders whenever any item
    // is visible, so a member on an SSO session — who reads their own teams'
    // rosters, as they always have — sees "Organisation · People".
    id: 'organisation',
    heading: 'Organisation',
    items: [
      {
        path: '/admin/people',
        label: 'People',
        visibleTo: ({ canManageOrganization, isOwner, isUoaSession }) =>
          isUoaSession || isOwner || canManageOrganization,
        icon: peopleIcon,
      },
      { path: '/admin/teams', label: 'Teams', visibleTo: ownerOrAdmin, icon: teamsIcon },
      {
        path: '/admin/organisation',
        label: 'Organisation',
        visibleTo: ({ canManageOrganization }) => canManageOrganization,
        icon: organizationIcon,
      },
      { path: '/admin/models', label: 'AI models', visibleTo: ownerOrAdmin, icon: modelsIcon },
      {
        path: '/admin/connections',
        label: 'Company connections',
        visibleTo: ownerOrAdmin,
        icon: connectionsIcon,
      },
      // Writing an organisation key is owner-gated (`canManageSecretScope`
      // refuses every scope above personal to anyone else), so the doorway is.
      { path: '/admin/keys', label: 'Keys', ownerOnly: true, icon: keyIcon },
      // Local usage and budgets. Owner-only operational telemetry never
      // appears on a member-facing surface (AGENTS.md → Rule zero, check 3).
      { path: '/admin/usage', label: 'Usage and limits', ownerOnly: true, icon: usageIcon },
      {
        path: '/admin/billing',
        label: 'Credits and billing',
        visibleTo: ownerOrAdmin,
        icon: creditsIcon,
      },
      {
        // Not owner-only as a page: the audit log keeps its owner gate inside
        // its tab, and organisation administrators reach the programs signed in
        // as people, Allow pairing and revocation, as before.
        path: '/admin/security',
        label: 'Security',
        visibleTo: ({ canManageOrganization, isAdmin, isOwner }) =>
          isOwner || isAdmin || canManageOrganization,
        icon: shieldIcon,
      },
    ],
  },
  {
    // What an owner or an instance operator reaches for rarely: the raw tool
    // registry, the access rule table, the deployment's health and its push
    // credentials, and the session debug.
    id: 'advanced',
    heading: 'Advanced',
    collapsedByDefault: true,
    visibleTo: ({ isOwner, isSuperAdmin }) => isOwner || isSuperAdmin,
    items: [
      { path: '/admin/advanced/tools', label: 'Tool registry', ownerOnly: true, icon: toolIcon },
      { path: '/admin/advanced/access-rules', label: 'Access rules', ownerOnly: true, icon: rulesIcon },
      {
        path: '/admin/advanced/announcements',
        label: 'Announcements',
        visibleTo: (viewer) => viewer.isSuperAdmin,
        icon: announcementsIcon,
      },
      {
        // Deployment-wide infrastructure (worker heartbeat, queue, dead jobs).
        // `GET /api/ops/health` requires `User.superAdmin`.
        path: '/admin/advanced/health',
        label: 'System health',
        visibleTo: ({ isSuperAdmin }) => isSuperAdmin,
        icon: healthIcon,
      },
      {
        path: '/admin/advanced/push',
        label: 'Mobile push setup',
        visibleTo: ({ isSuperAdmin }) => isSuperAdmin,
        icon: pushIcon,
      },
      {
        path: '/admin/advanced/debug',
        label: 'Session debug',
        visibleTo: ({ isOwner, isSuperAdmin }) => isOwner || isSuperAdmin,
        icon: debugIcon,
      },
    ],
  },
];

/** One gate for every item: its own rule when it has one, else `ownerOnly`. */
export const isAdminNavItemVisible = (item: AdminNavItem, viewer: AdminNavViewer): boolean =>
  item.visibleTo ? item.visibleTo(viewer) : !item.ownerOnly || viewer.isOwner;

export const isAdminNavGroupVisible = (group: AdminNavGroup, viewer: AdminNavViewer): boolean =>
  group.visibleTo
    ? group.visibleTo(viewer)
    : group.items.some((item) => isAdminNavItemVisible(item, viewer));

/**
 * Whether `pathname` lights up this item: its own path or anything beneath it,
 * so an agent's page, its designer and its mailbox keep "Agents" active, and a
 * team's page keeps "Teams".
 */
export const isAdminNavItemActive = (item: AdminNavItem, pathname: string): boolean =>
  pathname === item.path || pathname.startsWith(`${item.path}/`);
