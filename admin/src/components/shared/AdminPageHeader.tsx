import { MobileMenuButton } from '../../layouts/admin-shell/MobileMenuButton'
import {
  ResponsivePageHeader,
  type PageHeaderAction,
} from './ResponsivePageHeader'

type AdminPageHeaderProps = {
  actions?: PageHeaderAction[]
  eyebrow?: string
  title: string
  titleTone?: 'page' | 'section'
}

// Standard route-level header. Navigation ownership remains with the shell;
// this component only gives route pages the same measured action overflow and
// mobile drawer doorway as the Knowledge workspace.
export const AdminPageHeader = ({
  actions,
  eyebrow,
  title,
  titleTone = 'section',
}: AdminPageHeaderProps) => (
  <ResponsivePageHeader
    actions={actions}
    eyebrow={eyebrow}
    leading={<MobileMenuButton />}
    title={title}
    titleTone={titleTone}
  />
)
