/**
 * What Project › Settings says when the server refuses a change.
 *
 * The API's own messages were written for its logs — they name "executors",
 * "knowledge spaces" and the sign-in provider's product — so each refusal a
 * person can meet here is said again in the page's words, by code, with the
 * place that fixes it where there is one. An unknown code falls back to the
 * server's message rather than to nothing: a refusal must always be said.
 * Pure, so the words are pinned without rendering React.
 */

import { ApiClientError } from '@nessie/client-core'

export type ProjectVisibility = 'public' | 'protected'

export const PROJECT_VISIBILITY_COPY: Record<
  ProjectVisibility,
  { consequence: string; description: string; label: string }
> = {
  public: {
    consequence: 'Once saved, everyone in the organisation can open this project.',
    description: 'Everyone in the organisation can open it and read its boards and documents.',
    label: 'Public',
  },
  protected: {
    consequence:
      'Once saved, people outside this project see only its name, description and members.',
    description: 'People outside it see only its name, description and members.',
    label: 'Protected',
  },
}

const errorCode = (cause: unknown): string | undefined =>
  cause instanceof ApiClientError ? cause.code : undefined

const fallbackMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

/** A refused save on General or People. */
export const projectChangeRefusal = (cause: unknown): string => {
  switch (errorCode(cause)) {
    case 'TEAM_NAME_MANAGED_BY_SSO':
      return 'This project takes its name from a team in your sign-in provider. Rename the team there and the new name appears here.'
    case 'TEAM_PROJECT_MEMBERSHIP_MANAGED_BY_SSO':
      return 'This project mirrors a team in your sign-in provider, so its people are that team’s members. Change the team’s membership instead.'
    case 'PROJECT_NOT_FOUND':
      return 'This project is no longer available to you.'
    default:
      return fallbackMessage(cause, 'That change could not be saved.')
  }
}

export type DeleteBlock = {
  /** Where the person fixes it, when there is a page for that here. */
  doorway?: { label: string; to: string }
  sentence: string
}

type ServerBlock = { code?: unknown; message?: unknown }

const serverBlocks = (cause: unknown): ServerBlock[] => {
  if (!(cause instanceof ApiClientError)) return []
  const details = cause.details as { blocks?: unknown } | undefined
  return Array.isArray(details?.blocks) ? (details.blocks as ServerBlock[]) : []
}

const blockFor = (projectId: string, block: ServerBlock): DeleteBlock => {
  switch (block.code) {
    case 'PROJECT_HAS_KNOWLEDGE':
      return {
        doorway: { label: 'Open Docs', to: `/projects/${projectId}/docs` },
        sentence: 'It still holds documents. Move or delete them first.',
      }
    case 'PROJECT_HAS_EXECUTORS':
      return {
        doorway: { label: 'Open Computers', to: '/admin/computers' },
        sentence: 'A computer belongs to this project alone. Remove that computer first.',
      }
    case 'PROJECT_HAS_EXTERNAL_TEAMS':
      return {
        sentence:
          'It mirrors a team in your sign-in provider. Delete the team there, and the project goes with it.',
      }
    default:
      return {
        sentence: typeof block.message === 'string' && block.message
          ? block.message
          : 'Something in this project still depends on it.',
      }
  }
}

/**
 * Why a delete was refused, one line per reason. The route sends every
 * blocking family at once so nobody is sent round the loop once per family;
 * a refusal without that list is still said, in one line.
 */
export const projectDeleteRefusal = (projectId: string, cause: unknown): DeleteBlock[] => {
  const blocks = serverBlocks(cause)
  if (blocks.length > 0) return blocks.map((block) => blockFor(projectId, block))
  if (errorCode(cause) === 'PROJECT_NOT_EMPTY') {
    return [{ sentence: 'Something in this project still refers to it. Empty the project and try again.' }]
  }
  return [{ sentence: fallbackMessage(cause, 'The project could not be deleted.') }]
}
