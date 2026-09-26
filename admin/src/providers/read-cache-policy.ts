import { hashKey, type QueryKey } from '@tanstack/react-query'
import {
  BoardRecordSchema,
  BoardTasksResponseSchema,
  ChannelRecordSchema,
  ProjectDirectoryEntrySchema,
  ProjectRecordSchema,
  TeamRecordSchema,
  type MeResponse,
} from '@nessie/schemas'
import type { z } from 'zod'
import { channelKeys } from '../facades/channels/keys'
import { projectKeys } from '../facades/projects/keys'
import { taskKeys } from '../facades/tasks/keys'
import { teamKeys } from '../facades/team/keys'

const same = (a: QueryKey, b: QueryKey) => hashKey(a) === hashKey(b)

/** Deliberate allowlist: no credentials, memberships, mail, message/document bodies or live runs. */
export const projectCachedRead = (key: QueryKey, data: unknown): unknown | undefined => {
  let schema: z.ZodTypeAny | undefined
  if (same(key, channelKeys.all)) schema = ChannelRecordSchema.array()
  else if (same(key, projectKeys.all)) schema = ProjectRecordSchema.array()
  else if (same(key, projectKeys.directory)) schema = ProjectDirectoryEntrySchema.array()
  else if (same(key, teamKeys.all)) schema = TeamRecordSchema.array()
  else if (typeof key[1] === 'string' && same(key, projectKeys.boards(key[1]))) {
    schema = BoardRecordSchema.array()
  } else if (typeof key[1] === 'string' && typeof key[3] === 'string'
    && same(key, taskKeys.forBoard(key[1], key[3]))) {
    schema = BoardTasksResponseSchema
  }
  const result = schema?.safeParse(data)
  return result?.success ? result.data : undefined
}

/** Only called with the live /me response, before authenticated children render. */
export const readCacheScope = (baseUrl: string, me: MeResponse): string => JSON.stringify([
  baseUrl,
  me.user.id,
  me.context.organizationId,
  me.context.projectId,
  me.context.teamId,
  [...me.user.roleIds].sort(),
  me.user.superAdmin,
  (me.memberships ?? []).map((membership) => [
    membership.organizationId,
    membership.role,
    membership.projects.map((project) => [
      project.projectId, project.teams.map((team) => team.teamId).sort(),
    ]).sort(),
  ]).sort(),
])
