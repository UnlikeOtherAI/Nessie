import { useLocation } from 'react-router-dom';
import { NAV_ITEMS } from '../../navigation/nav-items';
import { usePhoneNavigation } from './PhoneNavigationProvider';
import { useCloseTransientMenus } from './TransientMenuContext';

// Bottom tab bar for mobile web (browser). The native app provides its own
// native glass tab bar instead, so this is only mounted when NOT in the native
// shell. Mirrors the compact top-level sections from the shared nav registry.
// Taps route through the shared phone navigation ledger: reselecting the
// active tab returns to its root without stacking a duplicate entry, and
// switching tabs follows the same pop/replace/push decisions the native tab
// bar and the Back doorway make.
export const MobileTabBar = () => {
  const { pathname } = useLocation();
  const navigation = usePhoneNavigation();
  const closeTransientMenus = useCloseTransientMenus();
  const tabItems = NAV_ITEMS.filter((item) => item.showInMobileTab !== false);

  return (
    <nav className="mobile-tabbar">
      {tabItems.map((item) => {
        const Icon = item.icon;
        const active = item.isActive(pathname);
        return (
          <button
            aria-current={active ? 'page' : undefined}
            className={`mobile-tabbar-item${active ? ' active' : ''}`}
            key={item.id}
            onClick={() => {
              closeTransientMenus();
              navigation?.selectTab(item.to);
            }}
            type="button"
          >
            <span className="mobile-tabbar-icon">
              <Icon className="h-[22px] w-[22px]" />
            </span>
            <span className="mobile-tabbar-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
