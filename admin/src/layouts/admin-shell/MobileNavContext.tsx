import { createContext, useContext } from 'react';

type MobileNavContextValue = {
  openDrawer: () => void;
};

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

export const MobileNavProvider = MobileNavContext.Provider;

// Returns the mobile-nav controls when rendered inside the admin shell, or null
// otherwise (so PhoneNavigationButton can no-op safely off-shell).
export const useMobileNav = (): MobileNavContextValue | null => useContext(MobileNavContext);
