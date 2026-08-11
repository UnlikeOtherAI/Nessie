import { usePhoneLayout } from '../../lib/mobile-shell';
import { MobileMenuButton } from './MobileMenuButton';
import { ResponsivePageHeader } from '../../components/shared/ResponsivePageHeader';

// A phone-only top bar (hamburger + section title) for pages that have no header
// of their own (the Agents and Knowledge column browsers). Renders nothing on
// desktop / tablet (iPad) / large web, where the secondary sidebar is shown inline.
export const MobileSectionHeader = ({ title }: { title: string }) => {
  const phoneLayout = usePhoneLayout();
  if (!phoneLayout) {
    return null;
  }
  return <ResponsivePageHeader leading={<MobileMenuButton />} title={title} />;
};
