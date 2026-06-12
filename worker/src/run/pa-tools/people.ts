import { Prisma } from '@prisma/client'
import { parseUserId } from '@nessie/schemas'
import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { requireActingUserId } from './access.js'
import { clampLimit, formatSection } from './tool-output.js'

export const runPeopleSearchTool = async (
  context: BuiltinToolRuntimeContext,
  query: string,
  limit: unknown = 10,
): Promise<ToolExecutionResult> => {
  const searchQuery = query.trim()
  if (!searchQuery) {
    throw new Error('query is required.')
  }

  const take = clampLimit(limit, 10)
  const people = await context.prisma.user.findMany({
    where: {
      organizationMembers: {
        some: { organizationId: context.channel.organizationId },
      },
      OR: [
        { displayName: { contains: searchQuery, mode: 'insensitive' } },
        { email: { contains: searchQuery, mode: 'insensitive' } },
      ],
    },
    orderBy: { displayName: 'asc' },
    select: {
      id: true,
      displayName: true,
      email: true,
      organizationMembers: {
        where: { organizationId: context.channel.organizationId },
        select: { role: true },
        take: 1,
      },
    },
    take,
  })

  const lines = people.map((person, index) => {
    const role = person.organizationMembers[0]?.role ?? 'member'
    const youLabel = person.id === requireActingUserId(context) ? ' (you)' : ''
    return `${index + 1}. ${person.displayName}${youLabel} <${person.email}> | userId=${person.id} | role=${role}`
  })

  return {
    inputSummary: `query=${searchQuery}`,
    outputPreview:
      formatSection(`People (${lines.length})`, lines) ||
      `No people matched "${searchQuery}".`,
    toolName: 'people_search',
  }
}

export const runUpdatePreferencesTool = async (
  context: BuiltinToolRuntimeContext,
  preferences: Record<string, unknown> | null,
): Promise<ToolExecutionResult> => {
  if (!preferences || Object.keys(preferences).length === 0) {
    throw new Error('preferences must be a non-empty object.')
  }

  const userId = requireActingUserId(context)
  const updatedUser = await context.prisma.user.update({
    where: { id: parseUserId(userId) },
    data: { preferences: preferences as Prisma.InputJsonValue },
    select: {
      id: true,
      preferences: true,
    },
  })

  return {
    inputSummary: 'preferences',
    outputPreview: `Updated preferences for userId=${updatedUser.id}\n${JSON.stringify(
      updatedUser.preferences ?? {},
    )}`,
    toolName: 'update_preferences',
  }
}
