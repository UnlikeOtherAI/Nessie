import type { KnowledgeAccessSummary } from '@nessie/schemas'
import type {
  KnowledgePageRecord,
  KnowledgeSpaceRecord,
} from '../../../../facades/knowledge/hooks'

/**
 * The small, testable facts the menus need about what they are acting on: the
 * link a row copies, the sentence a delete confirms with, and — the one that
 * matters — which kind of container an item is in.
 *
 * They are pure and they are here rather than in the hook because each one is
 * a decision rather than a rendering: whether "Sharing…" can grant at all
 * follows from `spaceAccessSummary` alone.
 */

/**
 * What kind of audience an item's container has. There is deliberately no
 * `KnowledgeSpace.kind` column, so this reads the two metadata flags and the
 * owner agent exactly as the server's own home-line derivation does — a third
 * spelling of the same fact is how "personal" and "project" drift apart.
 *
 * `ownPersonal` is handed in rather than re-derived: only the caller knows who
 * is signed in, and "my own documents" is the whole grant condition.
 */
export const spaceAccessSummary = (
  space: KnowledgeSpaceRecord,
  ownPersonal: boolean,
): KnowledgeAccessSummary => {
  if (space.metadata?.personal === true && ownPersonal) {
    return { canShare: true, mode: 'personal', shareCount: 0 }
  }
  if (space.metadata?.projectDocuments === true) {
    return {
      memberCount: 0,
      mode: 'project',
      projectId: space.projectId,
      // The space is named after the project it documents, so the row's own
      // name is the project's name until the read-out's own fetch says better.
      projectName: space.name,
    }
  }
  if (space.ownerAgentId) {
    return {
      agentId: space.ownerAgentId,
      agentName: space.name.replace(/\s+—\s+Documents$/u, ''),
      memberUserCount: space.memberUserIds.length,
      mode: 'agent',
    }
  }
  return {
    canManageAccess: space.canManageAccess,
    memberAgentCount: space.memberAgentIds.length,
    memberUserCount: space.memberUserIds.length,
    mode: 'space',
    spaceId: space.id,
    spaceName: space.name,
    visibility: space.visibility,
    writeRestricted: space.writeRestricted,
  }
}

/**
 * The address a row copies. A folder's link opens the browser *at* the folder;
 * everything else opens the item. Both are addresses the Finder already reads
 * on a cold start, so a pasted link lands where the person was.
 */
export const pageLink = (spaceId: string, pageId: string, folder: boolean): string => {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const base = `${origin}/knowledge-base/spaces/${encodeURIComponent(spaceId)}`
  return `${base}?${folder ? 'folder' : 'pageId'}=${encodeURIComponent(pageId)}`
}

export type DeleteConfirmCopy = { title: string; body: string; confirmLabel: string }

/**
 * Delete, in the words of what actually happens (menus-and-dialogs.md §8).
 *
 * The verb is "Delete" because the bytes go: `DELETE /pages/:id` archives the
 * row and purges its stored files through `FileService` first, and there is no
 * Trash to restore from. "Move to Trash" would be a lie about recoverable
 * data, which is the one kind of lie a confirm dialog cannot afford.
 */
export const deleteConfirmCopy = (pages: KnowledgePageRecord[]): DeleteConfirmCopy => {
  if (pages.length > 1) {
    return {
      body: 'Uploaded files inside them are removed from storage straight away.',
      confirmLabel: `Delete ${pages.length} items`,
      title: `Delete ${pages.length} items?`,
    }
  }
  const page = pages[0]
  if (!page) return { body: '', confirmLabel: 'Delete', title: 'Delete?' }
  const shared = (page.shareCount ?? 0) > 0
    ? ` It is shared with ${page.shareCount} ${page.shareCount === 1 ? 'person' : 'people'},`
      + ' who will lose access.'
    : ''
  const body = page.kind === 'folder'
    ? 'Everything inside it will be deleted too. Uploaded files are removed from'
      + ' storage straight away.'
    : page.kind === 'file'
      ? 'Its versions are removed from storage straight away.'
      : 'Its versions and comments are removed.'
  return {
    body: `${body}${shared}`,
    confirmLabel: 'Delete',
    title: `Delete “${page.title}”?`,
  }
}
