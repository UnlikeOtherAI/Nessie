import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserAvatar } from '../../components/primitives/UserAvatar';
import { DebugTokenButton } from '../../components/shared/DebugTokenButton';
import { useProductSurfaces } from '../../facades/integrations/useProductSurfaces';
import { useCurrentOrganization } from '../../facades/organization/hooks';
import { useAuthedObjectUrl } from '../../lib/uploads';
import { useAuthSession } from '../../providers/AuthSessionProvider';
import { NAV_ITEMS } from './nav-items';
import { UserMenuPopover } from './UserMenuPopover';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const SIDEBAR_RAIL_ITEMS = NAV_ITEMS.filter((item) => item.id !== 'search');

type SidebarRailProps = {
  onLogout: () => void;
  pathname: string;
};

export const SidebarRail = ({ onLogout, pathname }: SidebarRailProps) => {
  const { token, me } = useAuthSession();
  const { navPages: productNavPages } = useProductSurfaces();
  const { data: organization } = useCurrentOrganization();
  const logoUrl = useAuthedObjectUrl(organization?.logoAttachmentId ?? null, token);
  const avatarButtonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

      <WorkspaceSwitcher />

      {SIDEBAR_RAIL_ITEMS.map((item) => {
        const Icon = item.icon;
        return (
          <Link
            className={`admin-rail-btn ${item.isActive(pathname) ? 'active' : ''}`}
            key={item.id}
            to={item.to}
          >
            <span className="admin-rail-btn-icon">
              <Icon />
            </span>
            <span className="admin-rail-btn-label">{item.label}</span>
          </Link>
        );
      })}

      {productNavPages.map((page) => (
        <Link
          className={`admin-rail-btn ${pathname === page.route || pathname.startsWith(`${page.route}/`) ? 'active' : ''}`}
          key={page.productSlug + page.route}
          to={page.route}
        >
          <span className="admin-rail-btn-icon">
            <span
              className={[
                'flex h-5 w-5 items-center justify-center rounded-md text-[10px]',
                'font-bold text-[color:var(--on-accent)]',
              ].join(' ')}
              style={{ background: 'linear-gradient(135deg,var(--accent-strong),var(--accent))' }}
            >
              {(page.iconGlyph ?? page.label.slice(0, 1)).toUpperCase()}
            </span>
          </span>
          <span className="admin-rail-btn-label">{page.label}</span>
        </Link>
      ))}

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

      {me && (
        <>
          <button
            aria-haspopup="menu"
            aria-label="Account menu"
            className={[
              'rounded-full transition-shadow',
              menuOpen
                ? 'ring-2 ring-[color:var(--accent)]'
                : 'hover:ring-2 hover:ring-[color:var(--overlay)]',
            ].join(' ')}
            onClick={() => setMenuOpen((open) => !open)}
            ref={avatarButtonRef}
            title={me.user.displayName}
            type="button"
          >
            <UserAvatar
              avatarAttachmentId={me.user.avatarAttachmentId}
              avatarUrl={me.user.avatarUrl}
              displayName={me.user.displayName}
              gravatarUrl={me.user.gravatarUrl}
              ringColor="var(--rail)"
              size={32}
              token={token}
              userId={me.user.id}
            />
          </button>
          {menuOpen && (
            <UserMenuPopover
              anchorRef={avatarButtonRef}
              auth={me.auth}
              onClose={() => setMenuOpen(false)}
              onLogout={onLogout}
              token={token}
              user={me.user}
            />
          )}
        </>
      )}
    </aside>
  );
};
