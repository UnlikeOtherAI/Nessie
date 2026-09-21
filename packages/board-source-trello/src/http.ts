import {
  type SourceFetchInput,
  type SourceFetchStreamInput,
  type SourceStreamResponse,
  sourceFetchJson,
  sourceFetchStream,
} from '@nessie/board-sources'

export const TRELLO_API_HOST = 'api.trello.com'
export const TRELLO_WEB_HOST = 'trello.com'
export const TRELLO_ALLOWED_HOSTS = [TRELLO_API_HOST, TRELLO_WEB_HOST] as const

/**
 * The calls this adapter makes, through the shared envelope. Replaceable so
 * the lanes and write-backs can be tested against recorded answers;
 * production never sets it.
 */
export type TrelloTransport = {
  json: <T>(input: SourceFetchInput) => Promise<T>
  stream: (input: SourceFetchStreamInput) => Promise<SourceStreamResponse>
}

export const defaultTrelloTransport: TrelloTransport = {
  json: sourceFetchJson,
  stream: sourceFetchStream,
}

/** What every read of a card asks for, so an item always carries its files. */
export const CARD_FIELDS = 'id,idShort,name,desc,url,closed,idList,idMembers,labels,due,dateLastActivity'
export const ATTACHMENT_FIELDS = 'id,name,url,bytes,mimeType,isUpload,date'
