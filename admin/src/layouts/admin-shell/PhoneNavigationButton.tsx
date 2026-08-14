import { useLocation } from 'react-router-dom';
import { usePhoneLayout } from '../../lib/mobile-shell';
import {
  useColumnBackContext,
  useLocalBackSnapshot,
} from './local-back/LocalBackContext';
import { useMobileNav } from './MobileNavContext';
import { PhoneBackButton } from './PhoneBackButton';
import { getPhoneNavigationBackTarget } from './phone-navigation';
import { usePhoneNavigation } from './PhoneNavigationProvider';

// The phone's single leading doorway, with an explicit ownership order:
// an in-page local Back (deepest registered active action) > the route's
// deterministic Back > the section menu at tab roots. Desktop and tablet
// keep their pinned sidebar and per-column controls.
export const PhoneNavigationButton = () => {
  const phoneLayout = usePhoneLayout();
  const location = useLocation();
  const nav = useMobileNav();
  const history = usePhoneNavigation();
  const localBack = useLocalBackSnapshot()?.active ?? null;
  const column = useColumnBackContext();
  const backTarget = getPhoneNavigationBackTarget(location.pathname);

  if (!phoneLayout || !nav) {
    return null;
  }

  // Column browsers retain every column so their track can slide, but only
  // the column at the viewport origin owns interactive chrome. Without this
  // guard the off-screen list's route/menu button would re-render as the
  // active detail's local Back, leaving two Back controls in the DOM.
  if (column.index !== null && !column.phoneVisible) {
    return null;
  }

  if (localBack) {
    return <PhoneBackButton label={localBack.label} onBack={localBack.onBack} />;
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
