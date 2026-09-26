import type { ReactNode } from 'react';
import {
  bellIcon,
  computerIcon,
  connectionsIcon,
  creditsIcon,
  keyIcon,
  paletteIcon,
  personIcon,
  shieldIcon,
  statusIcon,
} from './nav-icons';

/** What the Your settings list needs to know about the person reading it. */
export type SettingsNavViewer = {
  /**
   * The billing service answered this person's capability read: there is a
   * billing subject to show them their usage of.
   */
  billingAvailable: boolean;
};

export type SettingsNavItem = {
  path: string;
  label: string;
  icon: ReactNode;
  visibleTo?: (viewer: SettingsNavViewer) => boolean;
};

/**
 * Your settings — the pages about the person reading them, opened from the
 * avatar menu. On `/settings/*` this is the sidebar column, and on a phone
 * `/settings` is this list.
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  { path: '/settings/profile', label: 'Profile', icon: personIcon },
  { path: '/settings/notifications', label: 'Notifications', icon: bellIcon },
  { path: '/settings/appearance', label: 'Appearance', icon: paletteIcon },
  { path: '/settings/status', label: 'Status', icon: statusIcon },
  { path: '/settings/accounts', label: 'Connected accounts', icon: connectionsIcon },
  { path: '/settings/computers', label: 'Your computers', icon: computerIcon },
  { path: '/settings/keys', label: 'Saved keys', icon: keyIcon },
  {
    // A person's own usage of the billing service's credits. Present only
    // where the billing service is configured and answers for this person.
    path: '/settings/usage',
    label: 'Usage',
    visibleTo: ({ billingAvailable }) => billingAvailable,
    icon: creditsIcon,
  },
  { path: '/settings/security', label: 'Security', icon: shieldIcon },
];

export const isSettingsNavItemVisible = (
  item: SettingsNavItem,
  viewer: SettingsNavViewer,
): boolean => item.visibleTo?.(viewer) ?? true;

/** A page and the records opened from it: a status, an account, a program. */
export const isSettingsNavItemActive = (item: SettingsNavItem, pathname: string): boolean =>
  pathname === item.path || pathname.startsWith(`${item.path}/`);
