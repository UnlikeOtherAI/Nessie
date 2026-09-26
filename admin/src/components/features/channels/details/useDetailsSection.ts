import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTabParam } from '../../../../navigation/useTabParam'
import {
  DETAILS_PARAM_SECTIONS,
  detailsPath,
  type DetailsSectionId,
} from './details-sections'

/**
 * Which Details section is on screen, and the way to choose another.
 *
 * A tab is never a history entry (docs/navigation/page-types-and-motion.md §1),
 * so every choice replaces. Four of the sections are `?section=` and go through
 * the one hook, `useTabParam`; People is its own kept route,
 * `/channels/:id/info/members`, so choosing it — or leaving it — is a
 * replacing navigation between two addresses the surface registry treats as
 * one screen. A section this conversation does not offer reads as General.
 */
export const useDetailsSection = (
  channelId: string,
  offered: readonly DetailsSectionId[],
): [DetailsSectionId, (next: DetailsSectionId) => void] => {
  const location = useLocation()
  const navigate = useNavigate()
  const [paramSection, selectParamSection] = useTabParam('section', DETAILS_PARAM_SECTIONS, 'general')
  const onPeople = /\/info\/members\/?$/.test(location.pathname)
  const named: DetailsSectionId = onPeople ? 'people' : paramSection
  const section: DetailsSectionId = offered.includes(named) ? named : 'general'

  const select = useCallback(
    (next: DetailsSectionId) => {
      if (next === section) return
      if (next === 'people' || onPeople) {
        void navigate(detailsPath(channelId, next, location.search), {
          replace: true,
          state: location.state,
        })
        return
      }
      selectParamSection(next)
    },
    [channelId, location.search, location.state, navigate, onPeople, section, selectParamSection],
  )

  return [section, select]
}
