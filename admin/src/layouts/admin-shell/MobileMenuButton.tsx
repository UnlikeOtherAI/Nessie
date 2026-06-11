import { useMobileLayout } from '../../lib/mobile-shell';
import { useMobileNav } from './MobileNavContext';

// Top-left hamburger shown on every page header in the mobile layout. Opens the
// contextual secondary-nav drawer. Renders nothing on desktop / large web (where
// the secondary sidebar is shown inline) or outside the admin shell.
export const MobileMenuButton = () => {
  const mobileLayout = useMobileLayout();
  const nav = useMobileNav();

  if (!mobileLayout || !nav) {
    return null;
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
