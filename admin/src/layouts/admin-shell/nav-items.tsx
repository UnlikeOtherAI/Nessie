import type { ReactNode } from 'react';

// Route prefixes that make up the admin area (settings + the ops/governance
// surfaces). Shared by the "Admin" nav section and the shell's sidebar selection
// (useAdminShell imports this so there is a single source of truth).
export const ADMIN_ROUTE_PREFIXES = [
  '/settings',
  '/agents',
  '/workflows',
  // Apps (the store) and Connectors (its governance surface) are one pair;
  // /apps/:slug belongs to the same section as its list.
  '/apps',
  '/mcp-app-store',
  '/approvals',
  '/audit',
  '/tokens',
  '/policy',
  '/ops',
];

// Strip query/hash and trailing slashes so route-family checks compare the
// semantic pathname only (a tab root with ?state stays its root screen).
export const normalizeAdminPathname = (pathname: string): string => {
  const normalized = (pathname.split(/[?#]/, 1)[0] ?? '/').replace(/\/+$/, '');
  return normalized || '/';
};

export const matchesAdminRoute = (pathname: string): boolean =>
  ADMIN_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export type NavSectionId =
  | 'channels'
  | 'projects'
  | 'knowledge'
  | 'admin'
  | 'search';

export type NavItem = {
  id: NavSectionId;
  label: string;
  to: string;
  isActive: (pathname: string) => boolean;
  icon: (props: { className?: string }) => ReactNode;
  showInMobileTab?: boolean;
};

const svgProps = {
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.8,
  viewBox: '0 0 24 24',
};

const ChannelsIcon = ({ className = 'h-5 w-5' }: { className?: string }) => (
  <svg className={className} {...svgProps}>
    <path
      d={[
        'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8',
        'a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72',
        'C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
      ].join(' ')}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ProjectsIcon = ({ className = 'h-5 w-5' }: { className?: string }) => (
  <svg className={className} {...svgProps}>
    <path
      d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const SearchIcon = ({ className = 'h-5 w-5' }: { className?: string }) => (
  <svg className={className} {...svgProps}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const KnowledgeIcon = ({ className = 'h-5 w-5' }: { className?: string }) => (
  <svg className={className} {...svgProps}>
    <path d="M4 19.5A2.5 2.5 0 016.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M4 4.5A2.5 2.5 0 016.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const AdminIcon = ({ className = 'h-5 w-5' }: { className?: string }) => (
  <svg className={className} {...svgProps}>
    <path
      d={[
        'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0',
        'a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37',
        'a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35',
        'a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37',
        'a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0',
        'a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37',
        'a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35',
        'a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37',
        ' .996.608 2.296.07 2.572-1.065z',
      ].join(' ')}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The top-level sections, in display order. Drives the desktop rail, the
// mobile web tab bar, and the native tab bar / route↔tab sync.
export const NAV_ITEMS: NavItem[] = [
  {
    id: 'channels',
    label: 'Channels',
    to: '/channels',
    isActive: (pathname) => pathname.startsWith('/channels'),
    icon: ChannelsIcon,
  },
  {
    id: 'projects',
    label: 'Projects',
    to: '/projects',
    isActive: (pathname) => pathname.startsWith('/projects'),
    icon: ProjectsIcon,
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    to: '/knowledge-base',
    // Dashboards live inside Knowledge rather than owning a first-column
    // section, so the Knowledge entry stays lit while you are in one.
    isActive: (pathname) =>
      pathname.startsWith('/knowledge-base') || pathname.startsWith('/dashboards'),
    icon: KnowledgeIcon,
  },
  {
    id: 'admin',
    label: 'Admin',
    to: '/settings',
    isActive: matchesAdminRoute,
    icon: AdminIcon,
  },
  {
    id: 'search',
    label: 'Search',
    to: '/search',
    isActive: (pathname) => pathname.startsWith('/search'),
    icon: SearchIcon,
  },
];

export const activeNavSection = (pathname: string): NavSectionId | null =>
  NAV_ITEMS.find((item) => item.isActive(pathname))?.id ?? null;
