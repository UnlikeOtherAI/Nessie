import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { DebugTokenButton } from '../../components/shared/DebugTokenButton';
import { useViewport } from '../../hooks/useViewport';
import { CreateMenuTrigger } from './CreateMenuTrigger';
import { NAV_ITEMS } from './nav-items';
import { resolveSectionNavTarget } from './section-route-memory';
import { RailTooltip } from './RailTooltip';
import { UserMenuTrigger } from './UserMenuTrigger';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import { useFocusMode } from '../../providers/FocusModeProvider';

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
  const { focusModeEnabled, toggleFocusMode, updating } = useFocusMode();
  const { capabilities } = useViewport();
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const [focusTooltipOpen, setFocusTooltipOpen] = useState(false);

  useEffect(() => {
    if (
      !focusTooltipOpen
      || capabilities.hover
      || !capabilities.coarsePointer
    ) {
      return undefined;
    }

    // Touch browsers can retain focus after a tap, leaving this otherwise
    // hover-only affordance visible. Give it a short, predictable lifetime.
    const timeoutId = window.setTimeout(() => setFocusTooltipOpen(false), 5_000);
    return () => window.clearTimeout(timeoutId);
  }, [capabilities.coarsePointer, capabilities.hover, focusTooltipOpen]);

  const showFocusTooltip = (): void => {
    setFocusTooltipOpen(true);
  };
  const focusTooltipTitle = focusModeEnabled ? 'Turn off focus mode' : 'Turn on focus mode';
  const focusTooltipDescription = focusModeEnabled
    ? 'Resume notifications and attention cues.'
    : 'Pause notifications and reduce badging and bolding.';
  return (
    <aside
      className={[
        'flex h-full w-[65px] flex-col items-center overflow-x-hidden overflow-y-auto',
        'bg-[color:var(--rail)] px-2 py-2',
      ].join(' ')}
    >
      <WorkspaceSwitcher />

      <nav aria-label="Main navigation" className="w-full shrink-0">
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
      </nav>

      <div className="flex-1" />

      <div className="flex w-full shrink-0 flex-col items-center">
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

        <button
          aria-describedby={focusTooltipOpen ? 'focus-mode-tooltip' : undefined}
          aria-label={focusTooltipTitle}
          aria-pressed={focusModeEnabled}
          className={`admin-rail-btn ${focusModeEnabled ? 'active' : ''}`}
          disabled={updating}
          onClick={toggleFocusMode}
          onBlur={() => setFocusTooltipOpen(false)}
          onFocus={showFocusTooltip}
          onMouseEnter={showFocusTooltip}
          onMouseLeave={() => setFocusTooltipOpen(false)}
          ref={focusButtonRef}
          type="button"
        >
          <span className="admin-rail-btn-icon">
            <svg fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
              <path d="M20.6 15.8A8.8 8.8 0 0 1 8.2 3.4 8.8 8.8 0 1 0 20.6 15.8Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="admin-rail-btn-label">Focus</span>
        </button>

        <RailTooltip
          anchorRef={focusButtonRef}
          description={focusTooltipDescription}
          id="focus-mode-tooltip"
          open={focusTooltipOpen}
          title={focusTooltipTitle}
        />

        <DebugTokenButton />

        <CreateMenuTrigger
          onCreateChannel={onCreateChannel}
          onCreateMessage={onCreateMessage}
          onCreateProject={onCreateProject}
        />

        <UserMenuTrigger onLogout={onLogout} />
      </div>
    </aside>
  );
};
