import type { KnowledgePageShareAccess, KnowledgeRootSpace } from '@nessie/schemas'

/** The five values `KnowledgeVisibilitySchema` holds, named where they are read. */
type KnowledgeVisibility = KnowledgeRootSpace['visibility']

/**
 * Every sentence the sharing surfaces say, in one place (menus-and-dialogs.md
 * §4).
 *
 * They are here rather than inline in the dialogs for two reasons. The first is
 * that the copy *is* the feature: "nobody has to approve it" and "shared pages
 * are not included in the recipient's search" are the two things the owner
 * asked to be told, and a sentence that can drift out of a test is a sentence
 * that will. The second is that a read-out has to be provably a read-out — no
 * function here returns anything a person can press.
 */

export type ShareSubjectKind = 'folder' | 'document' | 'file'

/** A headline the dialog sets in the emphatic weight, and the sentence under it. */
export type AccessReadout = { headline: string; body: string }

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * The no-approval statement and the edit boundary, on screen, every time the
 * Share dialog opens. The owner's words were "they're going to get it without
 * any approval gate"; this is that promise, said to the person making it so
 * they are never surprised by it.
 */
export const shareIntroSentence = (kind: ShareSubjectKind): string => {
  const subject = kind === 'folder'
    ? 'this folder and everything inside it, including what is added later'
    : kind === 'file'
      ? 'this file'
      : 'this document'
  return `People you add can open, read and download ${subject}.`
    + ' Give someone editing to let them change it — they still can’t share,'
    + ' move, publish or delete it.'
    + ' They get it straight away; nobody has to approve it.'
}

/**
 * The honest limit. A shared page opens from Shared with me and nowhere else:
 * the chunk-scope mirror has no per-person arm, so retrieval cannot reach it
 * (overview → "Deliberately left out"). Said at both levels, because "can
 * edit" sounds like "has it properly" and does not.
 */
export const SHARED_SEARCH_SENTENCE =
  'Shared documents open from the recipient’s Shared with me.'
  + ' Shared pages are not included in the recipient’s search, whatever their access.'

/**
 * Project documents. **A read-out, not a grant surface.** Access follows the
 * project's membership — rule 2 of the team model, where every project member
 * has equal rights — so there is nothing here to hand out, and saying so is
 * the whole job of this dialog.
 */
export const projectReadout = (projectName: string): AccessReadout => ({
  body: 'Access follows the project’s membership. To change who can see these'
    + ' documents, add or remove people in the project — there is no separate'
    + ' sharing for a project’s documents.',
  headline: `Everyone in the project ${projectName} can see this.`,
})

/** A shared folder (an ad-hoc space): its visibility, plus whoever was added. */
export const spaceReadout = (input: {
  visibility: KnowledgeVisibility
  spaceName: string
  projectName?: string | null
  writeRestricted: boolean
}): AccessReadout => {
  const headline = (() => {
    switch (input.visibility) {
      case 'organization':
        return 'Everyone in the organisation can see this.'
      case 'project':
        return `Everyone in the project ${input.projectName ?? 'this folder belongs to'} can see this.`
      case 'team':
        return 'Everyone on the team can see this.'
      case 'channel':
        return 'Everyone in the channel can see this.'
      default:
        return `Only people added to the folder ${input.spaceName} can see this.`
    }
  })()
  const where = input.visibility === 'team' || input.visibility === 'channel'
    ? `Plus the people added to the folder ${input.spaceName}.`
    : input.visibility === 'private'
      ? ''
      : `It is in the shared folder ${input.spaceName}.`
  const restricted = input.writeRestricted
    ? ' Editing is restricted to the people listed.'
    : ''
  return { body: [where, restricted.trim()].filter(Boolean).join(' '), headline }
}

/** An agent's documents home: its audience is the agent's own. */
export const agentReadout = (agentName: string, memberUserCount: number): AccessReadout => ({
  body: memberUserCount > 0
    ? `${plural(memberUserCount, 'person', 'people')} ${memberUserCount === 1 ? 'was' : 'were'} also added directly.`
    : 'Nobody has been added directly.',
  headline: `People who can see the agent ${agentName} can see its documents.`,
})

/** A row in Shared with me: what the level the viewer holds actually means. */
export const sharedToMeReadout = (
  sharerName: string,
  access: KnowledgePageShareAccess,
): AccessReadout =>
  access === 'edit'
    ? {
      body: 'Your changes are saved as new versions under your name; only'
        + ` ${sharerName} can publish it, move it, delete it or change who has access.`,
      headline: `${sharerName} shared this with you and you can edit it.`,
    }
    : {
      body: `You can read it and download it; only ${sharerName} can change who has access.`,
      headline: `${sharerName} shared this with you.`,
    }

/** The viewer's own personal documents, seen through Get Info rather than Share. */
export const personalReadout = (shareCount: number): AccessReadout => ({
  body: shareCount === 0
    ? 'Only you, so far.'
    : `Shared with ${plural(shareCount, 'person', 'people')}.`,
  headline: 'Only you can see this, and anyone you share it with.',
})

/** The level a share row reads out, in the two words the menu also uses. */
export const shareLevelLabel: Record<KnowledgePageShareAccess, string> = {
  edit: 'Can edit',
  view: 'Can view',
}
