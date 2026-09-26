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

/** "Design", "Design and Support", "Design, Research and Support". */
export const joinNames = (names: readonly string[], locale: string): string =>
  new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)

// At team scope the roster is always the viewer's current team, whose name is
// known only when the session lists it.
const teamsPhrase = (
  teamNames: readonly string[],
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string =>
  teamNames.length > 0 ? joinNames(teamNames, locale) : t('members.feedback.yourTeam')

type Translate = (key: string, options?: Record<string, unknown>) => string

export const invitationSentToast = (
  email: string,
  teamNames: readonly string[],
  locale: string,
  t: Translate,
): ToastInput => ({
  body: t('members.feedback.invitationSentBody', { email, teams: teamsPhrase(teamNames, locale, t) }),
  title: t('members.feedback.invitationSent'),
})

export const invitationResentToast = (who: string, t: Translate): ToastInput => ({
  body: t('members.feedback.invitationResentBody', { who }),
  title: t('members.feedback.invitationResent'),
})

export const invitationCancelledToast = (who: string, t: Translate): ToastInput => ({
  body: t('members.feedback.invitationCancelledBody', { who }),
  title: t('members.feedback.invitationCancelled'),
})

export const memberAddedToast = (name: string, teamName: string | undefined, t: Translate): ToastInput => ({
  body: t('members.feedback.memberAddedBody', { name, team: teamName ?? t('members.feedback.yourTeam') }),
  title: t('members.feedback.memberAdded'),
})
