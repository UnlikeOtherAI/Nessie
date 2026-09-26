import type { KnowledgePageShareAccess, KnowledgeRootSpace } from '@nessie/schemas'
import { finderText } from './finder-text'

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

export type ShareSubjectKind = 'folder' | 'document' | 'file' | 'spreadsheet'

/** A headline the dialog sets in the emphatic weight, and the sentence under it. */
export type AccessReadout = { headline: string; body: string }

/**
 * The no-approval statement and the edit boundary, on screen, every time the
 * Share dialog opens. The owner's words were "they're going to get it without
 * any approval gate"; this is that promise, said to the person making it so
 * they are never surprised by it.
 */
export const shareIntroSentence = (kind: ShareSubjectKind): string => {
  const subject = kind === 'folder'
    ? finderText('shareSubjectFolder', 'this folder and everything inside it, including what is added later')
    : kind === 'file'
      ? finderText('shareSubjectFile', 'this file')
      // A spreadsheet is edited live and in place, so "download" is the
      // export rather than the thing itself — and a person given editing is
      // typing in the same grid as everybody else, which is worth its own word.
      : kind === 'spreadsheet'
        ? finderText('shareSubjectSpreadsheet', 'this spreadsheet, and export it')
        : finderText('shareSubjectDocument', 'this document')
  return finderText('shareIntro', 'People you add can open, read and download {{subject}}. Give someone editing to let them change it — they still can’t share, move, publish or delete it. They get it straight away; nobody has to approve it.', { subject })
}

/**
 * The honest limit. A shared page opens from Shared with me and nowhere else:
 * the chunk-scope mirror has no per-person arm, so retrieval cannot reach it
 * (overview → "Deliberately left out"). Said at both levels, because "can
 * edit" sounds like "has it properly" and does not.
 */
export const sharedSearchSentence = (): string =>
  `${finderText('sharedOpenSentence', 'Shared documents open from the recipient’s Shared with me.')} ${finderText('sharedSearchSentence', 'Shared pages are not included in the recipient’s search, whatever their access.')}`

/**
 * Project documents. **A read-out, not a grant surface.** Access follows the
 * project's membership — rule 2 of the team model, where every project member
 * has equal rights — so there is nothing here to hand out, and saying so is
 * the whole job of this dialog.
 */
export const projectReadout = (projectName: string): AccessReadout => ({
  body: finderText('projectReadoutBody', 'Access follows the project’s membership. To change who can see these documents, add or remove people in the project — there is no separate sharing for a project’s documents.'),
  headline: finderText('projectReadoutHeadline', 'Everyone in the project {{projectName}} can see this.', { projectName }),
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
        return finderText('visibilityOrganisation', 'Everyone in the organisation can see this.')
      case 'project':
        return finderText('visibilityProject', 'Everyone in the project {{projectName}} can see this.', { projectName: input.projectName ?? 'this folder belongs to' })
      case 'team':
        return finderText('visibilityTeam', 'Everyone on the team can see this.')
      case 'channel':
        return finderText('visibilityChannel', 'Everyone in the channel can see this.')
      default:
        return finderText('visibilityPrivate', 'Only people added to the folder {{spaceName}} can see this.', { spaceName: input.spaceName })
    }
  })()
  const where = input.visibility === 'team' || input.visibility === 'channel'
    ? finderText('visibilityPlusPeople', 'Plus the people added to the folder {{spaceName}}.', { spaceName: input.spaceName })
    : input.visibility === 'private'
      ? ''
      : finderText('visibilityInFolder', 'It is in the shared folder {{spaceName}}.', { spaceName: input.spaceName })
  const restricted = input.writeRestricted
    ? ` ${finderText('editingRestricted', 'Editing is restricted to the people listed.')}`
    : ''
  return { body: [where, restricted.trim()].filter(Boolean).join(' '), headline }
}

/** An agent's documents home: its audience is the agent's own. */
export const agentReadout = (agentName: string, memberUserCount: number): AccessReadout => ({
  body: memberUserCount > 0
    ? finderText(memberUserCount === 1 ? 'directPeople_one' : 'directPeople_other', memberUserCount === 1 ? '{{count}} person was also added directly.' : '{{count}} people were also added directly.', { count: memberUserCount })
    : finderText('nobodyDirect', 'Nobody has been added directly.'),
  headline: finderText('agentReadoutHeadline', 'People who can see the agent {{agentName}} can see its documents.', { agentName }),
})

/** A row in Shared with me: what the level the viewer holds actually means. */
export const sharedToMeReadout = (
  sharerName: string,
  access: KnowledgePageShareAccess,
): AccessReadout =>
  access === 'edit'
    ? {
      body: finderText('sharedEditBody', 'Your changes are saved as new versions under your name; only {{sharerName}} can publish it, move it, delete it or change who has access.', { sharerName }),
      headline: finderText('sharedEditHeadline', '{{sharerName}} shared this with you and you can edit it.', { sharerName }),
    }
    : {
      body: finderText('sharedViewBody', 'You can read it and download it; only {{sharerName}} can change who has access.', { sharerName }),
      headline: finderText('sharedViewHeadline', '{{sharerName}} shared this with you.', { sharerName }),
    }

/** The viewer's own personal documents, seen through Get Info rather than Share. */
export const personalReadout = (shareCount: number): AccessReadout => ({
  body: shareCount === 0
    ? finderText('personalOnly', 'Only you, so far.')
    : finderText(shareCount === 1 ? 'personalShared_one' : 'personalShared_other', shareCount === 1 ? 'Shared with {{count}} person.' : 'Shared with {{count}} people.', { count: shareCount }),
  headline: finderText('personalHeadline', 'Only you can see this, and anyone you share it with.'),
})

/** The level a share row reads out, in the two words the menu also uses. */
export const shareLevelLabel = (access: KnowledgePageShareAccess): string =>
  finderText(access === 'edit' ? 'shareCanEdit' : 'shareCanView', access === 'edit' ? 'Can edit' : 'Can view')
