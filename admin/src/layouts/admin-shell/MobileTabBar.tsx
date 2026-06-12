import { Link, useLocation } from 'react-router-dom';
import { NAV_ITEMS } from './nav-items';

// Bottom tab bar for mobile web (browser). The native app provides its own
// native glass tab bar instead, so this is only mounted when NOT in the native
// shell. Mirrors the 5 top-level sections from the shared nav registry.
export const MobileTabBar = () => {
  const { pathname } = useLocation();

  return (
    <nav className="mobile-tabbar">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.isActive(pathname);
        return (
          <Link
            aria-current={active ? 'page' : undefined}
            className={`mobile-tabbar-item${active ? ' active' : ''}`}
            key={item.id}
            to={item.to}
          >
            <span className="mobile-tabbar-icon">
              <Icon className="h-[22px] w-[22px]" />
            </span>
            <span className="mobile-tabbar-label">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
};
