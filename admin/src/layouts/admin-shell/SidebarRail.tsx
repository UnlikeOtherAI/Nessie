import { Link } from 'react-router-dom';
import { faArrowRightFromBracket } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useCurrentOrganization } from '../../facades/organization/hooks';
import { useAuthedObjectUrl } from '../../lib/uploads';
import { useAuthSession } from '../../providers/AuthSessionProvider';

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
  isAgentsRoute: boolean;
  isAdminRoute: boolean;
  onLogout: () => void;
  pathname: string;
};

export const SidebarRail = ({
  displayName,
  isAgentsRoute,
  isAdminRoute,
  onLogout,
  pathname,
}: SidebarRailProps) => {
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

      <Link
        className={`admin-rail-btn ${pathname.startsWith('/channels') ? 'active' : ''}`}
        to="/channels"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
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
        <span className="admin-rail-btn-label">Channels</span>
      </Link>

      <Link
        className={`admin-rail-btn ${pathname.startsWith('/projects') ? 'active' : ''}`}
        to="/projects"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="admin-rail-btn-label">Projects</span>
      </Link>

      <Link
        className={`admin-rail-btn ${isAgentsRoute ? 'active' : ''}`}
        to="/agents"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="8" r="4" />
          <path
            d="M4 20c0-4 3.582-7 8-7s8 3 8 7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="19" cy="13" r="2.5" style={{ stroke: 'var(--thinking)' }} />
        </svg>
        <span className="admin-rail-btn-label">Agents</span>
      </Link>

      <Link
        className={`admin-rail-btn ${pathname.startsWith('/knowledge-base') ? 'active' : ''}`}
        to="/knowledge-base"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path
            d="M4 19.5A2.5 2.5 0 016.5 17H20"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 4.5A2.5 2.5 0 016.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="admin-rail-btn-label">Knowledge</span>
      </Link>

      <div className="my-2 h-px w-8 bg-[color:var(--overlay)]" />

      <Link
        className={`admin-rail-btn ${isAdminRoute ? 'active' : ''}`}
        to="/settings"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
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
          <path
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="admin-rail-btn-label">Admin</span>
      </Link>

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
