import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useViewport } from '../../hooks/useViewport';
import { CreateMenuTrigger } from './CreateMenuTrigger';
import { NAV_ITEMS } from './nav-items';
import { usePhoneNavigation } from './PhoneNavigationProvider';
import { RailTooltip } from './RailTooltip';
import { sidebarAriaCurrent } from './SidebarRow';
import { UserMenuTrigger } from './UserMenuTrigger';
import { TeamSwitcher } from './TeamSwitcher';
import { useFocusMode } from '../../providers/FocusModeProvider';

const SIDEBAR_RAIL_ITEMS = NAV_ITEMS.filter((item) => item.id !== 'search');
type SidebarRailProps = {
  onCreateAgent: () => void;
  onCreateChannel: () => void;
  onCreateMessage: () => void;
  onCreateProject: () => void;
  onLogout: () => void;
  pathname: string;
};

export const SidebarRail = ({
  onCreateAgent,
  onCreateChannel,
  onCreateMessage,
  onCreateProject,
  onLogout,
  pathname,
}: SidebarRailProps) => {
  const navigation = usePhoneNavigation();
  const { focusModeEnabled, toggleFocusMode, updating } = useFocusMode();
  const { capabilities } = useViewport();
  const focusButtonRef = useRef<HTMLButtonElement>(null);
  const [focusTooltipOpen, setFocusTooltipOpen] = useState(false);
  const dismissFocusTooltip = useCallback((): void => setFocusTooltipOpen(false), []);

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
    const timeoutId = window.setTimeout(dismissFocusTooltip, 5_000);
    return () => window.clearTimeout(timeoutId);
  }, [capabilities.coarsePointer, capabilities.hover, dismissFocusTooltip, focusTooltipOpen]);

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
      <TeamSwitcher />

      <nav aria-label="Main navigation" className="w-full shrink-0">
        {SIDEBAR_RAIL_ITEMS.map((item) => {
          const Icon = item.icon;
          // Return to where the reader last stood in this section rather than its
          // root, so switching tabs and coming back restores the exact page and
          // its URL state. The active section's own button resolves to the
          // current location, which is a harmless no-op navigation.
          const isActive = item.isActive(pathname);
          return (
            <Link
              aria-current={sidebarAriaCurrent(isActive)}
              className={`admin-rail-btn ${isActive ? 'active' : ''}`}
              key={item.id}
              to={navigation?.sectionTarget(item.id, item.to) ?? item.to}
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

        <button
          aria-describedby={focusTooltipOpen ? 'focus-mode-tooltip' : undefined}
          aria-label={focusTooltipTitle}
          aria-pressed={focusModeEnabled}
          className={`admin-rail-btn ${focusModeEnabled ? 'active' : ''}`}
          disabled={updating}
          onClick={toggleFocusMode}
          onBlur={dismissFocusTooltip}
          onFocus={showFocusTooltip}
          onMouseEnter={showFocusTooltip}
          onMouseLeave={dismissFocusTooltip}
          ref={focusButtonRef}
          type="button"
        >
          <span className="admin-rail-btn-icon">
            <svg aria-hidden="true" className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M21.75 15.002A9.72 9.72 0 0 1 12 21.75C6.615 21.75 2.25 17.385 2.25 12c0-4.14 2.58-7.678 6.223-9.094a.75.75 0 0 1 .983.868 7.5 7.5 0 0 0 9.402 9.402.75.75 0 0 1 .892.826Z" />
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

        <CreateMenuTrigger
          onCreateAgent={onCreateAgent}
          onCreateChannel={onCreateChannel}
          onCreateMessage={onCreateMessage}
          onCreateProject={onCreateProject}
        />

        <UserMenuTrigger onLogout={onLogout} />
      </div>
    </aside>
  );
};
