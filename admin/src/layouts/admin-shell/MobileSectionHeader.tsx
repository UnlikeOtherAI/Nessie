import { usePhoneLayout } from '../../lib/mobile-shell';
import { MobileMenuButton } from './MobileMenuButton';

// A phone-only top bar (hamburger + section title) for pages that have no header
// of their own (the Agents and Knowledge column browsers). Renders nothing on
// desktop / tablet (iPad) / large web, where the secondary sidebar is shown inline.
export const MobileSectionHeader = ({ title }: { title: string }) => {
  const phoneLayout = usePhoneLayout();
  if (!phoneLayout) {
    return null;
  }
  return (
    <header className="flex h-[50px] flex-shrink-0 items-center border-b border-[color:var(--sep)] px-3">
      <MobileMenuButton />
      <span className="text-[15px] font-bold text-[color:var(--tx)]">{title}</span>
    </header>
  );
};
