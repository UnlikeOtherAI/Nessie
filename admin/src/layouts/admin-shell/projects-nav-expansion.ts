import type { ProjectRecord } from '../../lib/api-client'

/**
 * Pure helpers behind the Projects sidebar's expand/collapse cookies (which
 * projects have their sections open, and which have the boards inside Board
 * open — `ProjectsSidebarNav.tsx` owns the two cookie names and the state
 * that reads/writes them; this module holds only the value transforms).
 */

export const parseExpandedProjectIds = (value: string | null): Set<string> => {
  if (!value) return new Set()

  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

export const retainExpandedProjectIds = (
  expandedProjectIds: ReadonlySet<string>,
  projects: readonly ProjectRecord[],
): Set<string> => {
  const projectIds = new Set(projects.map((project) => project.id))
  return new Set([...expandedProjectIds].filter((projectId) => projectIds.has(projectId)))
}

export const serializeExpandedProjectIds = (expandedProjectIds: ReadonlySet<string>): string =>
  JSON.stringify([...expandedProjectIds])
