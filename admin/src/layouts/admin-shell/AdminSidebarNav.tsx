import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

type AdminSidebarNavProps = {
  pathname: string;
  isOwner: boolean;
  isSuperAdmin: boolean;
};

type AdminNavItem = {
  path: string;
  label: string;
  icon: ReactNode;
  ownerOnly?: boolean;
};

type AdminNavGroup = {
  heading: string;
  ownerOnly?: boolean;
  superAdminOnly?: boolean;
  items: AdminNavItem[];
};

const icon = (path: ReactNode) => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    {path}
  </svg>
);

const ADMIN_NAV: AdminNavGroup[] = [
  {
    heading: 'General',
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
      {
        path: '/settings/members',
        label: 'Members',
        ownerOnly: true,
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
    heading: 'Workspace',
    items: [
      {
        path: '/settings/channels',
        label: 'Channels',
        icon: icon(
          <>
            <path d="M7 8h10M5 12h14M7 16h10" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/agents',
        label: 'Agents',
        icon: icon(
          <>
            <rect height="10" rx="2" width="14" x="5" y="8" />
            <path d="M12 8V5M9 13h.01M15 13h.01" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/settings/tools',
        label: 'Tools',
        icon: icon(
          <path
            d="M14.7 6.3a4 4 0 105 5l-6.9 6.9a2 2 0 11-2.8-2.8l6.9-6.9a4 4 0 00-2.2-2.2zM7 17l-1.5 1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />,
        ),
      },
    ],
  },
  {
    heading: 'Governance',
    ownerOnly: true,
    items: [
      {
        path: '/approvals',
        label: 'Approvals',
        icon: icon(<path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />),
      },
      {
        path: '/audit',
        label: 'Audit log',
        icon: icon(
          <>
            <path d="M6 3h9l3 3v15H6z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 9h6M9 13h6M9 17h4" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/tokens',
        label: 'Token usage',
        icon: icon(
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v8M9.5 10.5h3.5a1.5 1.5 0 010 3H9.5" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
      {
        path: '/policy',
        label: 'Policy',
        icon: icon(
          <path
            d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6l7-3z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />,
        ),
      },
      {
        path: '/ops',
        label: 'Health',
        icon: icon(
          <path d="M3 12h4l2 6 4-12 2 6h6" strokeLinecap="round" strokeLinejoin="round" />,
        ),
      },
    ],
  },
  {
    heading: 'Platform',
    superAdminOnly: true,
    items: [
      {
        path: '/settings/push',
        label: 'Push notifications',
        icon: icon(
          <>
            <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M13.7 21a2 2 0 01-3.4 0" strokeLinecap="round" strokeLinejoin="round" />
          </>,
        ),
      },
    ],
  },
];

export const AdminSidebarNav = ({ pathname, isOwner, isSuperAdmin }: AdminSidebarNavProps) => {
  return (
    <aside
      className={[
        'flex h-full w-[220px] flex-col overflow-y-auto',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
      ].join(' ')}
    >
      <div className="flex h-[50px] items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Admin</span>
      </div>
      <nav className="flex flex-1 flex-col gap-3 px-2 py-1">
        {ADMIN_NAV.filter(
          (group) =>
            (!group.ownerOnly || isOwner) && (!group.superAdminOnly || isSuperAdmin),
        ).map((group) => (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
              {group.heading}
            </div>
            {group.items
              .filter((item) => !item.ownerOnly || isOwner)
              .map((item) => {
                const isActive = pathname === item.path || pathname.startsWith(`${item.path}/`);
                return (
                  <Link
                    key={item.path}
                    className={[
                      'admin-sb-item flex items-center gap-2.5 px-3 py-2 text-[13px]',
                      isActive ? 'active' : '',
                    ].join(' ')}
                    to={item.path}
                  >
                    {item.icon}
                    {item.label}
                  </Link>
                );
              })}
          </div>
        ))}
      </nav>
    </aside>
  );
};
