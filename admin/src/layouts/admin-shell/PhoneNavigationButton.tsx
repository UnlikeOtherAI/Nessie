import { useLocation } from 'react-router-dom';
import { usePhoneLayout } from '../../lib/mobile-shell';
import { useMobileNav } from './MobileNavContext';
import { PhoneBackButton } from './PhoneBackButton';
import { getPhoneNavigationBackTarget } from './phone-navigation';
import { usePhoneNavigation } from './PhoneNavigationProvider';

// The phone's leading doorway mirrors a native navigation controller: exactly
// one control per screen. A local/nested Back (an open in-page stack) is owned
// by the page itself and wins; this route-level control shows Back at detail
// routes and Menu at section roots. Desktop and tablet keep the pinned sidebar.
export const PhoneNavigationButton = () => {
  const phoneLayout = usePhoneLayout();
  const location = useLocation();
  const nav = useMobileNav();
  const history = usePhoneNavigation();
  const backTarget = getPhoneNavigationBackTarget(location.pathname);

  if (!phoneLayout || !nav) {
    return null;
  }

  if (backTarget) {
    return (
      <PhoneBackButton
        label={backTarget.label}
        onBack={() => history?.performBack()}
      />
    );
  }

  return (
    <button
      aria-label="Open navigation"
      className={[
        '-ml-1 mr-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg',
        'text-[color:var(--tx2)] transition-colors hover:bg-[color:var(--overlay-weak)]',
      ].join(' ')}
      onClick={nav.openDrawer}
      type="button"
    >
      <svg
        aria-hidden="true"
        className="h-5 w-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        viewBox="0 0 24 24"
      >
        <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
};
