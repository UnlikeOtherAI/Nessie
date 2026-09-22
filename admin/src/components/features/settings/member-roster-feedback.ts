import type { ToastInput } from '../../../providers/ToastProvider'

/**
 * What a person is told once a change on the Members page has gone through.
 *
 * Each of these actions closes the dialog it was made in, so the outcome is a
 * toast — the content-design rule for a result whose surface is gone
 * (docs/plans/2026-09-01-content-design-system/overview.md §4.5). Before this,
 * sending an invitation closed the dialog without a word, and the only way to
 * learn it had worked was to open the Pending tab.
 *
 * The address or name goes in the body, never the title: a toast title is one
 * ellipsised line, and the part a person checks is the part that runs long.
 */

const LIST = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' })

/** "Design", "Design and Support", "Design, Research and Support". */
export const joinNames = (names: readonly string[]): string => LIST.format(names)

// At team scope the roster is always the viewer's current team, whose name is
// known only when the session lists it.
const teamsPhrase = (teamNames: readonly string[]): string =>
  teamNames.length > 0 ? joinNames(teamNames) : 'your team'

export const invitationSentToast = (email: string, teamNames: readonly string[]): ToastInput => ({
  body: `${email} is invited to ${teamsPhrase(teamNames)}.`,
  title: 'Invitation sent',
})

export const invitationResentToast = (who: string): ToastInput => ({
  body: `We’ve emailed ${who} again.`,
  title: 'Invitation sent again',
})

export const invitationCancelledToast = (who: string): ToastInput => ({
  body: `You can invite ${who} again at any time.`,
  title: 'Invitation cancelled',
})

export const memberAddedToast = (name: string, teamName: string | undefined): ToastInput => ({
  body: `${name} is now in ${teamName ?? 'your team'}.`,
  title: 'Member added',
})
