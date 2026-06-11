import type { ReactNode } from 'react';

type MobileNavDrawerProps = {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

// Slide-in left drawer that hosts the contextual secondary navigation on mobile.
// The child is one of the existing secondary-nav components (SidebarNav,
// AdminSidebarNav, …) which already carry their own width / background / scroll.
// Mirrors the scrim (z-40) + panel (z-50) pattern from AgentDetailDrawer.
export const MobileNavDrawer = ({ open, onClose, children }: MobileNavDrawerProps) => (
  <>
    <button
      aria-hidden={!open}
      aria-label="Close navigation"
      className={[
        'fixed inset-0 z-40 bg-[color:var(--scrim-strong)] transition-opacity duration-200',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
      onClick={onClose}
      tabIndex={-1}
      type="button"
    />
    <div
      className={[
        'fixed inset-y-0 left-0 z-50 flex max-w-[85vw] transition-transform duration-200',
        'shadow-[0_24px_80px_var(--scrim-strong)]',
        open ? 'translate-x-0' : '-translate-x-full',
      ].join(' ')}
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {children}
    </div>
  </>
);
