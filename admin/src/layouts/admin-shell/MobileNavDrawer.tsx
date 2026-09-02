import type { ReactNode } from 'react';
import { Sheet } from '../../components/overlays/Sheet';

type MobileNavDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

// Slide-in left drawer that hosts the contextual secondary navigation on mobile.
// The child is one of the existing secondary-nav components (SidebarNav,
// AdminSidebarNav, …) which already carry their own width / background / scroll,
// so the sheet takes the `auto` geometry and stays narrower than the viewport —
// the scrim beside it is the tap target that closes it.
export const MobileNavDrawer = ({ open, onClose, children }: MobileNavDrawerProps) => (
  <Sheet onClose={onClose} open={open} side="left" size="auto" title="Navigation">
    <div
      className="flex min-h-0 flex-1 shadow-[0_24px_80px_var(--scrim-strong)]"
      style={{
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingTop: 'env(safe-area-inset-top)',
      }}
    >
      {children}
    </div>
  </Sheet>
);
