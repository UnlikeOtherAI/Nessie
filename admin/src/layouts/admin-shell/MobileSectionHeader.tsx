import { useLocation } from 'react-router-dom';
import { usePhoneLayout } from '../../lib/mobile-shell';
import { isPhoneTabRoot } from './phone-navigation';
import { PhoneNavigationButton } from './PhoneNavigationButton';
import { ResponsivePageHeader } from '../../components/shared/ResponsivePageHeader';

// A phone-only top bar (hamburger + section title) for pages that have no header
// of their own (the Agents and Knowledge column browsers). Renders nothing on
// desktop / tablet (iPad) / large web, where the secondary sidebar is shown inline.
export const MobileSectionHeader = ({ title }: { title: string }) => {
  const phoneLayout = usePhoneLayout();
  const { pathname } = useLocation();
  // Only at a section root: on detail routes the page's own header already
  // carries the shared route-level Back, and two stacked headers is the exact
  // defect this header exists to prevent.
  if (!phoneLayout || !isPhoneTabRoot(pathname)) {
    return null;
  }
  return <ResponsivePageHeader leading={<PhoneNavigationButton />} title={title} />;
};
