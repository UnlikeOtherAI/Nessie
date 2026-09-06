import { useLocation } from 'react-router-dom';
import { usePhoneLayout } from './mobile-shell';
import { useLocalBackSnapshot } from './LocalBackContext';
import { useMobileNav } from '../layouts/admin-shell/ShellStateContext';
import { PhoneBackButton } from './PhoneBackButton';
import { usePhoneNavigation } from '../layouts/admin-shell/PhoneNavigationProvider';

// The phone's single leading doorway. What it does is decided by the one
// Back resolver (navigation/back.ts): the topmost registered owner (an open
// overlay, the deepest nested stage) > the route's parent > the section menu
// at tab roots. This component only renders that decision; it never
// re-derives it. Desktop and tablet keep their pinned sidebar and
// per-column controls.
export const PhoneNavigationButton = () => {
  const phoneLayout = usePhoneLayout();
  const location = useLocation();
  const nav = useMobileNav();
  const navigation = usePhoneNavigation();
  // Subscribing to the registry snapshot re-renders this doorway when an
  // owner registers or leaves; the resolver reads the same snapshot.
  useLocalBackSnapshot();
  const action = navigation?.resolveBackAction(location.pathname) ?? null;

  if (!phoneLayout || !nav) {
    return null;
  }

  if (action) {
    return (
      <PhoneBackButton
        label={action.label}
        onBack={() => navigation?.performBack()}
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
