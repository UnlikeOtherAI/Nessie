import { Link } from 'react-router-dom';
import { DebugTokenButton } from '../../components/shared/DebugTokenButton';
import { CreateMenuTrigger } from './CreateMenuTrigger';
import { NAV_ITEMS } from './nav-items';
import { resolveSectionNavTarget } from './section-route-memory';
import { UserMenuTrigger } from './UserMenuTrigger';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const SIDEBAR_RAIL_ITEMS = NAV_ITEMS.filter((item) => item.id !== 'search');

type SidebarRailProps = {
  onCreateChannel: () => void;
  onCreateMessage: () => void;
  onCreateProject: () => void;
  onLogout: () => void;
  pathname: string;
};

export const SidebarRail = ({
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
  onLogout,
  pathname,
}: SidebarRailProps) => {
  return (
    <aside
      className={[
        'flex h-full w-[65px] flex-col items-center overflow-hidden',
        'bg-[color:var(--rail)] px-2 py-2',
      ].join(' ')}
    >
      <WorkspaceSwitcher />

      {SIDEBAR_RAIL_ITEMS.map((item) => {
        const Icon = item.icon;
        // Return to where the reader last stood in this section rather than its
        // root, so switching tabs and coming back restores the exact page and
        // its URL state. The active section's own button resolves to the
        // current location, which is a harmless no-op navigation.
        return (
          <Link
            className={`admin-rail-btn ${item.isActive(pathname) ? 'active' : ''}`}
            key={item.id}
            to={resolveSectionNavTarget(item.id, item.to)}
          >
            <span className="admin-rail-btn-icon">
              <Icon />
            </span>
            <span className="admin-rail-btn-label">{item.label}</span>
          </Link>
        );
      })}

      <div className="my-2 h-px w-8 bg-[color:var(--overlay)]" />

      <Link
        className={`admin-rail-btn ${pathname.startsWith('/feedback') ? 'active' : ''}`}
        to="/feedback"
      >
        <span className="admin-rail-btn-icon">
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            viewBox="0 0 24 24"
          >
            <path d="m3 11 18-5v12L3 14v-3z" strokeLinecap="round" strokeLinejoin="round" />
            <path
              d="M11.6 16.8a3 3 0 1 1-5.8-1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="admin-rail-btn-label">Feedback</span>
      </Link>

      <div className="flex-1" />

      <DebugTokenButton />

      <CreateMenuTrigger
        onCreateChannel={onCreateChannel}
        onCreateMessage={onCreateMessage}
        onCreateProject={onCreateProject}
      />

      <UserMenuTrigger onLogout={onLogout} />
    </aside>
  );
};
