import type {
  ConnectorConnectionContext,
  NormalizedEvent,
  SyncCheckpoint,
  SyncResult,
} from '@nessie/comms-connect'

import type { MicrosoftGraphClient, MicrosoftMailFolder } from './client.js'
import { nowMs, resolvePageSize, type MicrosoftConnectorDeps } from './config.js'
import { MicrosoftDeltaCursorExpiredError } from './errors.js'
import { normalizeMicrosoftDeletion, normalizeMicrosoftMessage } from './normalize.js'

const DEFAULT_OFF_FOLDERS = new Set(['junkemail', 'deleteditems'])
const MAX_FOLDER_PAGES = 20

type FolderCursor = { id: string; pageLink?: string; deltaLink?: string }
type DeltaCursor = {
  kind: 'initial' | 'incremental'
  folderIndex: number
  folders: FolderCursor[]
}

const minIso = (left: string | undefined, right: string): string =>
  left === undefined || right < left ? right : left

const maxIso = (left: string | undefined, right: string): string =>
  left === undefined || right > left ? right : left

const bounds = (
  events: readonly NormalizedEvent[],
  checkpoint: SyncCheckpoint,
): Pick<SyncCheckpoint, 'oldestImportedAt' | 'newestImportedAt'> => {
  let oldest = checkpoint.oldestImportedAt
  let newest = checkpoint.newestImportedAt
  for (const event of events) {
    oldest = minIso(oldest, event.occurredAt)
    newest = maxIso(newest, event.occurredAt)
  }
  return { oldestImportedAt: oldest, newestImportedAt: newest }
}

const parseCursor = (raw: string | undefined): DeltaCursor | undefined => {
  if (!raw) return undefined
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const candidate = value as Record<string, unknown>
    if (
      (candidate.kind !== 'initial' && candidate.kind !== 'incremental')
      || !Number.isInteger(candidate.folderIndex)
      || (candidate.folderIndex as number) < 0
      || !Array.isArray(candidate.folders)
    ) return undefined
    const folders = candidate.folders.flatMap((entry): FolderCursor[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const folder = entry as Record<string, unknown>
      if (typeof folder.id !== 'string' || folder.id.length === 0) return []
      return [{
        id: folder.id,
        ...(typeof folder.pageLink === 'string' ? { pageLink: folder.pageLink } : {}),
        ...(typeof folder.deltaLink === 'string' ? { deltaLink: folder.deltaLink } : {}),
      }]
    })
    if (folders.length !== candidate.folders.length) return undefined
    return { kind: candidate.kind, folderIndex: candidate.folderIndex as number, folders }
  } catch {
    return undefined
  }
}

const encodeCursor = (cursor: DeltaCursor): string => JSON.stringify(cursor)

const folderIsSyncable = (folder: MicrosoftMailFolder): boolean =>
  !DEFAULT_OFF_FOLDERS.has(folder.wellKnownName?.toLowerCase() ?? '')

const loadFolders = async (
  client: MicrosoftGraphClient,
  accessToken: string,
): Promise<FolderCursor[]> => {
  const folders: MicrosoftMailFolder[] = []
  let pageUrl: string | undefined
  for (let page = 0; page < MAX_FOLDER_PAGES; page += 1) {
    const response = await client.listMailFolders(accessToken, pageUrl)
    folders.push(...(response.value ?? []))
    pageUrl = response['@odata.nextLink']
    if (!pageUrl) break
  }
  if (pageUrl) {
    throw new Error('[comms-microsoft] Graph returned too many mail-folder pages')
  }
  return folders.flatMap((folder) =>
    typeof folder.id === 'string' && folder.id.length > 0 && folderIsSyncable(folder)
      ? [{ id: folder.id }]
      : [],
  )
}

const eventsFromPage = (
  tenantId: string,
  messages: readonly Parameters<typeof normalizeMicrosoftMessage>[1][],
  now: string,
): NormalizedEvent[] => messages.flatMap((message) => {
  if (message['@removed']) {
    return typeof message.id === 'string'
      ? [normalizeMicrosoftDeletion(tenantId, message.id, now)]
      : []
  }
  return [normalizeMicrosoftMessage(tenantId, message)]
})

const nextPage = async (
  client: MicrosoftGraphClient,
  deps: MicrosoftConnectorDeps,
  connection: ConnectorConnectionContext,
  cursor: DeltaCursor,
  checkpoint: SyncCheckpoint,
): Promise<SyncResult> => {
  const current = cursor.folders[cursor.folderIndex]
  if (!current) throw new MicrosoftDeltaCursorExpiredError()
  const page = await client.getFolderDelta(connection.credential.accessToken, {
    folderId: current.id,
    pageUrl: current.pageLink ?? current.deltaLink,
    pageSize: resolvePageSize(deps),
  })
  if (!page) throw new MicrosoftDeltaCursorExpiredError()
  const events = eventsFromPage(
    connection.externalTenantId,
    page.value ?? [],
    new Date(nowMs(deps)).toISOString(),
  )
  const folders = cursor.folders.map((folder) => ({ ...folder }))
  if (page['@odata.nextLink']) {
    folders[cursor.folderIndex] = { ...current, pageLink: page['@odata.nextLink'] }
    return {
      events,
      checkpoint: {
        ...checkpoint,
        cursor: encodeCursor({ ...cursor, folders }),
        ...bounds(events, checkpoint),
      },
      hasMore: true,
    }
  }
  if (!page['@odata.deltaLink']) {
    throw new Error('[comms-microsoft] Graph delta page carried no continuation link')
  }
  folders[cursor.folderIndex] = { id: current.id, deltaLink: page['@odata.deltaLink'] }
  const nextIndex = cursor.folderIndex + 1
  if (nextIndex < folders.length) {
    return {
      events,
      checkpoint: {
        ...checkpoint,
        cursor: encodeCursor({ ...cursor, folders, folderIndex: nextIndex }),
        ...bounds(events, checkpoint),
      },
      hasMore: true,
    }
  }
  return {
    events,
    checkpoint: {
      ...checkpoint,
      cursor: encodeCursor({ kind: 'incremental', folders, folderIndex: 0 }),
      ...bounds(events, checkpoint),
    },
    hasMore: false,
  }
}

export const runMicrosoftInitialSync = async (
  client: MicrosoftGraphClient,
  deps: MicrosoftConnectorDeps,
  connection: ConnectorConnectionContext,
  checkpoint: SyncCheckpoint = {},
): Promise<SyncResult> => {
  const cursor = parseCursor(checkpoint.cursor)
  if (cursor?.kind === 'incremental') {
    return { events: [], checkpoint, hasMore: false }
  }
  const initial = cursor ?? {
    kind: 'initial' as const,
    folderIndex: 0,
    folders: await loadFolders(client, connection.credential.accessToken),
  }
  if (initial.folders.length === 0) {
    return {
      events: [],
      checkpoint: {
        ...checkpoint,
        cursor: encodeCursor({ kind: 'incremental', folderIndex: 0, folders: [] }),
      },
      hasMore: false,
    }
  }
  return nextPage(client, deps, connection, initial, checkpoint)
}

export const runMicrosoftIncrementalSync = async (
  client: MicrosoftGraphClient,
  deps: MicrosoftConnectorDeps,
  connection: ConnectorConnectionContext,
  checkpoint: SyncCheckpoint,
): Promise<SyncResult> => {
  // History and incremental worker jobs persist independent checkpoints. The
  // first incremental job therefore starts empty even after history completed;
  // establish a new delta baseline instead of treating it as a stale cursor.
  // Any overlap is collapsed by CommsEvent's canonical idempotency layer.
  if (!checkpoint.cursor) {
    return runMicrosoftInitialSync(client, deps, connection, checkpoint)
  }
  const cursor = parseCursor(checkpoint.cursor)
  // An empty incremental job bootstraps through the same folder delta walk as
  // history. That walk can span many pages/folders, so keep advancing its
  // valid `initial` cursor until every folder has received a delta link.
  if (!cursor || (cursor.kind !== 'initial' && cursor.kind !== 'incremental')) {
    throw new MicrosoftDeltaCursorExpiredError()
  }
  if (cursor.folders.length === 0) return { events: [], checkpoint, hasMore: false }
  return nextPage(client, deps, connection, cursor, checkpoint)
}

export { DEFAULT_OFF_FOLDERS, parseCursor as decodeMicrosoftDeltaCursor }
