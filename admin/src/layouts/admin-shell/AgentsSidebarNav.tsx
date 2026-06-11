import { Link } from 'react-router-dom';

type AgentsSidebarNavProps = {
  pathname: string;
};

export const AgentsSidebarNav = ({ pathname }: AgentsSidebarNavProps) => {
  return (
    <aside
      className={[
        'flex h-full w-[220px] flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
      ].join(' ')}
    >
      <div className="flex h-[50px] items-center px-4">
        <span className="text-[15px] font-bold text-[color:var(--tx)]">Agents</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2 py-1">
        {[
          {
            path: '/agents',
            label: 'Agents',
            exact: true,
            icon: (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.582-7 8-7s8 3 8 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
          {
            path: '/agents/workflows',
            label: 'Workflows',
            icon: (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <rect height="4" rx="1" width="6" x="4" y="4" />
                <rect height="4" rx="1" width="6" x="14" y="10" />
                <rect height="4" rx="1" width="6" x="4" y="16" />
                <path d="M10 6h2a2 2 0 012 2v4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 12h-2a2 2 0 00-2 2v4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
          {
            path: '/agents/triggers',
            label: 'Triggers',
            icon: (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path d="M12 4v6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 16v4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M20 12h-4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M8 12H4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="12" cy="12" r="3.5" />
              </svg>
            ),
          },
          {
            path: '/agents/tools',
            label: 'Tools',
            icon: (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path d="M14.7 6.3a4 4 0 105 5l-6.9 6.9a2 2 0 11-2.8-2.8l6.9-6.9a4 4 0 00-2.2-2.2z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M7 17l-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
          {
            path: '/agents/activity',
            label: 'Activity',
            icon: (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <path d="M13 10V3L4 14h7v7l9-11h-7z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ),
          },
        ].map((item) => {
          const isActive = item.exact
            ? pathname === item.path
            : pathname.startsWith(item.path);
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
      </nav>
    </aside>
  );
};
