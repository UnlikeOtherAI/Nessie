import { Link } from 'react-router-dom';
import { faArrowRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useCurrentOrganization } from '../../facades/organization/hooks';
import { useAuthedObjectUrl } from '../../lib/uploads';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { NAV_ITEMS } from './nav-items';

const railUserAvatarClassName = [
  'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full',
  'text-[11px] font-bold text-[color:var(--on-accent)]',
].join(' ');

const railLogoutRowClassName = 'mt-2 flex w-full items-center gap-1.5';

const railLogoutLineClassName = 'h-px flex-1 rounded-full bg-[color:var(--sep)]';

const railLogoutButtonClassName = [
  'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded',
  'text-[color:var(--tx3)] transition-colors hover:text-[color:var(--tx)]',
].join(' ');

type SidebarRailProps = {
  displayName: string;
  onLogout: () => void;
  pathname: string;
};

export const SidebarRail = ({ displayName, onLogout, pathname }: SidebarRailProps) => {
  const { token } = useAuthSession();
  const { data: organization } = useCurrentOrganization();
  const logoUrl = useAuthedObjectUrl(organization?.logoAttachmentId ?? null, token);

  return (
    <aside
      className={[
        'flex h-full w-[65px] flex-col items-center overflow-hidden',
        'bg-[color:var(--rail)] px-2 py-2',
      ].join(' ')}
    >
      <Link
        className={[
          'mb-4 flex h-9 w-9 items-center justify-center overflow-hidden',
          logoUrl ? 'rounded-full' : 'rounded-xl',
        ].join(' ')}
        style={
          logoUrl
            ? undefined
            : { background: 'linear-gradient(135deg,var(--accent-strong),var(--accent))' }
        }
        title={organization?.name}
        to="/channels"
      >
        {logoUrl ? (
          <img
            alt={organization?.name ?? 'Workspace'}
            className="h-full w-full object-cover"
            src={logoUrl}
          />
        ) : (
          <svg
            fill="none"
            height="22"
            stroke="var(--on-accent)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="22"
          >
            <path
              d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z"
              fill="var(--overlay)"
            />
            <path d="M8 14s1.5 2 4 2 4-2 4-2" />
            <line x1="9" x2="9.01" y1="9" y2="9" />
            <line x1="15" x2="15.01" y1="9" y2="9" />
          </svg>
        )}
      </Link>

      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            className={`admin-rail-btn ${item.isActive(pathname) ? 'active' : ''}`}
            key={item.id}
            to={item.to}
          >
            <Icon />
            <span className="admin-rail-btn-label">{item.label}</span>
          </Link>
        );
      })}

      <div className="my-2 h-px w-8 bg-[color:var(--overlay)]" />

      <Link
        className={`admin-rail-btn ${pathname.startsWith('/feedback') ? 'active' : ''}`}
        to="/feedback"
      >
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
        <span className="admin-rail-btn-label">Feedback</span>
      </Link>

      <div className="flex-1" />

      <div className={railUserAvatarClassName} style={{ background: 'var(--accent)' }}>
        <span>{displayName.slice(0, 2).toUpperCase()}</span>
      </div>
      <div className={railLogoutRowClassName}>
        <span className={railLogoutLineClassName} />
        <button
          aria-label="Log out"
          className={railLogoutButtonClassName}
          onClick={onLogout}
          title="Log out"
          type="button"
        >
          <FontAwesomeIcon className="h-3.5 w-3.5" icon={faArrowRightFromBracket} />
        </button>
      </div>
    </aside>
  );
};
