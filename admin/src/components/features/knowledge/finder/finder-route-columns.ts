import type { ReactNode } from 'react'
import type { FinderColumnSlot } from './finder-view'

export const isKnowledgeAgentsRoute = (pathname: string): boolean =>
  pathname === '/knowledge-base/agents' || pathname.startsWith('/knowledge-base/agents/')

type FinderRouteColumnsInput = {
  agentsColumn: ReactNode | null
  columns: ReactNode[]
  folderCount: number
  orgScope: boolean
  pathname: string
  rootColumn: ReactNode
  single: boolean
  slots: FinderColumnSlot[]
  virtualColumnKey: string | null
}

/**
 * On a phone, an addressable root destination is already a route layer. It is
 * the base column for that layer; only folders below it become nested stages.
 * Wide layouts keep every ancestry column in their one horizontal track.
 */
export const finderRouteColumns = ({
  agentsColumn,
  columns,
  folderCount,
  orgScope,
  pathname,
  rootColumn,
  single,
  slots,
  virtualColumnKey,
}: FinderRouteColumnsInput): { columns: ReactNode[]; slots: FinderColumnSlot[] } => {
  if (!single || !orgScope) return { columns, slots }
  if (pathname === '/knowledge-base') return { columns: [rootColumn], slots: ['root'] }
  if (pathname === '/knowledge-base/agents') {
    return agentsColumn
      ? { columns: [agentsColumn], slots: ['virtual'] }
      : { columns: [rootColumn], slots: ['root'] }
  }
  if (pathname.startsWith('/knowledge-base/agents/')) {
    if (folderCount > 0) {
      return { columns: columns.slice(-folderCount), slots: slots.slice(-folderCount) }
    }
    return agentsColumn
      ? { columns: [agentsColumn], slots: ['virtual'] }
      : { columns: [rootColumn], slots: ['root'] }
  }
  if (pathname === '/knowledge-base/latest'
    || pathname === '/knowledge-base/shared-with-me') {
    return virtualColumnKey
      ? { columns: columns.slice(-1), slots: ['virtual'] }
      : { columns: [rootColumn], slots: ['root'] }
  }
  if (pathname.startsWith('/knowledge-base/spaces/') && folderCount > 0) {
    return { columns: columns.slice(-folderCount), slots: slots.slice(-folderCount) }
  }
  return { columns: [rootColumn], slots: ['root'] }
}
