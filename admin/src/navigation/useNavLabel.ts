import { useTranslation } from 'react-i18next'
import type { NavSectionId } from './nav-items'

/** The rail and phone tab bar read the same translated section names. */
export const useNavLabel = (): ((id: NavSectionId) => string) => {
  const { t } = useTranslation('shell')
  const labels: Record<NavSectionId, string> = {
    channels: t('navigation.channels'),
    projects: t('navigation.projects'),
    knowledge: t('navigation.knowledge'),
    admin: t('navigation.admin'),
    search: t('navigation.search'),
  }
  return (id) => labels[id]
}
