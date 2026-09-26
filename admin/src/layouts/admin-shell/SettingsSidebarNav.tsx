import { useMemo } from 'react';
import { useUoaBillingCapability } from '../../facades/billing/hooks';
import { isReactNativeWebView } from '../../lib/native-shell';
import { SidebarNavLink } from './SidebarNavLink';
import {
  SETTINGS_NAV,
  isSettingsNavItemActive,
  isSettingsNavItemVisible,
  type SettingsNavViewer,
} from './settings-nav-items';

/**
 * The Your settings list: the sidebar column on every `/settings` page, and on
 * a phone the `/settings` page itself. No rail item is lit on these pages, so
 * the list names where the reader is.
 */
export const SettingsSidebarNav = ({ pathname }: { pathname: string }) => {
  // The capability read either answers for this person or refuses (no
  // billing service, no billing subject); only an answer offers Usage.
  const billing = useUoaBillingCapability();
  const viewer = useMemo<SettingsNavViewer>(
    () => ({ billingAvailable: billing.isSuccess }),
    [billing.isSuccess],
  );

  return (
    <aside
      className={[
        'flex h-full w-full flex-col overflow-hidden',
        'border-r border-[color:var(--sep)] bg-[color:var(--sb)]',
        isReactNativeWebView() ? 'touch-sidebar' : '',
      ].join(' ')}
    >
      <nav aria-labelledby="settings-nav-heading" className="min-h-0 flex-1 overflow-y-auto py-1">
        <div className="sidebar-tree-section">
          <div className="admin-sec-row">
            <h2 className="admin-sec-hdr" id="settings-nav-heading" style={{ cursor: 'default' }}>
              Your settings
            </h2>
          </div>
        </div>
        {SETTINGS_NAV
          .filter((item) => isSettingsNavItemVisible(item, viewer))
          .map((item) => (
            <SidebarNavLink
              active={isSettingsNavItemActive(item, pathname)}
              icon={item.icon}
              key={item.path}
              label={item.label}
              to={item.path}
            />
          ))}
      </nav>
    </aside>
  );
};
