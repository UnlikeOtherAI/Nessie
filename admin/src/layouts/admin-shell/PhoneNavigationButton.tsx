import { useLocation, useNavigate } from 'react-router-dom';
import { usePhoneLayout } from '../../lib/mobile-shell';
import { useMobileNav } from './MobileNavContext';
import { PhoneBackButton } from './PhoneBackButton';
import { getPhoneNavigationBackTarget } from './phone-navigation';

// The phone's leading control mirrors a native navigation controller: section
// roots open their contextual drawer, while every routed child receives an
// in-context Back action. Desktop and tablet keep their pinned sidebar.
export const PhoneNavigationButton = () => {
  const phoneLayout = usePhoneLayout();
  const location = useLocation();
  const navigate = useNavigate();
  const nav = useMobileNav();
  const backTarget = getPhoneNavigationBackTarget(location.pathname);

  if (!phoneLayout || !nav) {
    return null;
  }

  if (backTarget) {
    return (
      <PhoneBackButton
        label={backTarget.label}
        onBack={() => void navigate(backTarget.pathname)}
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
