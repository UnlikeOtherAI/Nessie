/**
 * A conversation's Details: which sections it has, what each is called, and
 * the address of each (plan §6.6).
 *
 * The three `/info` routes stay routes, for Back and deep links, and the rest
 * of the sections are `?section=` on the first of them:
 *
 *   `/channels/:id/info`                 General (or `?section=` below)
 *   `/channels/:id/info/members`         People
 *   `/channels/:id/info/members/add`     adding people, a screen over People
 *
 * so each section has exactly one address — People is never also
 * `?section=people` — and switching sections replaces the entry: the surface
 * registry folds `/info` and `/info/members` into one screen at one depth.
 * Pure, so the rule is pinned without rendering React.
 */

import type { ChannelRecord } from '../../../../lib/api-client'

export type DetailsSectionId =
  | 'general'
  | 'people'
  | 'agents'
  | 'notifications'
  | 'responses'
  | 'automations'

/** What `?section=` may name on `/info`: every section but People, which is a route. */
export const DETAILS_PARAM_SECTIONS = [
  'general',
  'agents',
  'notifications',
  'responses',
  'automations',
] as const satisfies readonly DetailsSectionId[]

export const DETAILS_SECTION_LABELS: Record<DetailsSectionId, string> = {
  agents: 'Agents',
  automations: 'Automations',
  general: 'General',
  notifications: 'Notifications',
  people: 'People',
  // The decision policy, under a name a person can read: what it decides is
  // how the room's agents answer — reply, react, stay out, or take on work.
  responses: 'How agents respond',
}

type DetailsChannel = Pick<ChannelRecord, 'systemChannelType' | 'type'>

/**
 * A room (a standard, non-system channel) has all six sections. A direct
 * message — one-to-one, a group, or an agent's own home — has General, People
 * and Notifications: agents are placed only in rooms, a decision policy is
 * accepted only on a standard channel (docs/standards/channel-decision-policy.md),
 * and automations are installed on rooms. Whole sections a conversation can
 * never have are absent rather than empty (plan R9).
 */
export const detailsSections = (channel: DetailsChannel): DetailsSectionId[] =>
  isRoom(channel)
    ? ['general', 'people', 'agents', 'notifications', 'responses', 'automations']
    : ['general', 'people', 'notifications']

export const isRoom = (channel: DetailsChannel): boolean =>
  channel.type === 'standard' && !channel.systemChannelType

/** The section an address shows: People on its route, else `?section=`, else General. */
export const detailsSectionFromLocation = (pathname: string, search: string): DetailsSectionId => {
  if (/\/info\/members(?:\/add)?\/?$/.test(pathname)) return 'people'
  const named = new URLSearchParams(search).get('section')
  return DETAILS_PARAM_SECTIONS.find((section) => section === named) ?? 'general'
}

/**
 * The address of one section, carrying every other search param (the
 * conversation's own `?tab=` stays, so the room beneath a sheet does not jump
 * to Messages) and dropping only `section`, which the target restates.
 */
export const detailsPath = (
  channelId: string,
  section: DetailsSectionId,
  search = '',
): string => {
  const params = new URLSearchParams(search)
  params.delete('section')
  if (section !== 'general' && section !== 'people') params.set('section', section)
  const query = params.toString()
  const base = section === 'people'
    ? `/channels/${channelId}/info/members`
    : `/channels/${channelId}/info`
  return query ? `${base}?${query}` : base
}
