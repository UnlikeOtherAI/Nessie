import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ConnectedMailAccountRecordSchema,
  ConnectedMailConversationSchema,
  ConnectedMailPageSchema,
  ConnectedMailThreadSummarySchema,
} from '@nessie/schemas'
import type {
  ConnectedMailAccountRecord,
  ConnectedMailComposeInput,
  ConnectedMailboxSendInput,
  ConnectedMailDraftCreateInput,
  ConnectedMailConversation,
  ConnectedMailSource,
  ConnectedMailThreadSummary,
} from '@nessie/schemas'

import { useApiClient } from '../../providers/ApiClientProvider'
import { gmailKeys } from '../gmail/keys'
import type { GmailDraftActionStatus } from '../gmail/hooks'
import { connectedMailKeys } from './keys'

export type ConnectedMailPage<T> = {
  items: T[]
  nextCursor?: string
  previousCursor?: string
  estimate?: number
}

export type MailAddress = { accountId: string; source: ConnectedMailSource }

export const mailPath = ({ accountId, source }: MailAddress): string =>
  `/mail/${source}/${encodeURIComponent(accountId)}`

/**
 * `enabled` matters here: the chat doorway chip mounts on every message row, so
 * an ungated observer made each row refetch the account list. Entitlement is
 * still read live — `staleTime: 0` plus the explicit refetch before any open.
 */
export const useConnectedMailAccounts = (enabled = true) => {
  const apiClient = useApiClient()
  return useQuery<ConnectedMailAccountRecord[]>({
    enabled,
    queryKey: connectedMailKeys.accounts(),
    queryFn: async () => ConnectedMailAccountRecordSchema.array().parse(
      await apiClient.get('/api/mail/accounts'),
    ),
    staleTime: 0,
  })
}

export const useConnectedMailThreads = (
  address: MailAddress | null,
  input: { cursor?: string; pageSize: number; query: string; unreadOnly: boolean },
) => {
  const apiClient = useApiClient()
  return useQuery<ConnectedMailPage<ConnectedMailThreadSummary>>({
    enabled: Boolean(address),
    queryKey: connectedMailKeys.threads(address ?? { accountId: '', source: 'gmail' }, input),
    queryFn: async () => {
      if (!address) throw new Error('Choose a mailbox first.')
      const params = new URLSearchParams({ pageSize: String(input.pageSize) })
      if (input.cursor) params.set('cursor', input.cursor)
      if (input.query) params.set('query', input.query)
      if (input.unreadOnly) params.set('unreadOnly', 'true')
      return ConnectedMailPageSchema(ConnectedMailThreadSummarySchema).parse(
        await apiClient.get(`/api/mail/accounts/${address.source}/${encodeURIComponent(address.accountId)}/threads?${params}`),
      )
    },
  })
}

export const useConnectedMailConversation = (
  address: MailAddress | null,
  threadId: string | undefined,
  enabled = true,
) => {
  const apiClient = useApiClient()
  return useQuery<ConnectedMailConversation>({
    enabled: Boolean(address && threadId && enabled),
    queryKey: connectedMailKeys.conversation(address ?? { accountId: '', source: 'gmail' }, threadId),
    queryFn: async () => {
      if (!address || !threadId) throw new Error('Choose a conversation first.')
      return ConnectedMailConversationSchema.parse(await apiClient.get(
        `/api/mail/accounts/${address.source}/${encodeURIComponent(address.accountId)}/threads/${encodeURIComponent(threadId)}`,
      ))
    },
  })
}

export type ConnectedMailDraftResult = {
  id: string
  actionId?: string
  contentFingerprint?: string
  sendAfter?: string
  status?: string
}
export type MailboxSendActionStatus = {
  id: string
  state: 'ready' | 'dispatching' | 'sent' | 'delivery_unknown'
}

const mailMutationUrl = ({ accountId, source }: MailAddress, suffix: string): string =>
  `/api/mail/accounts/${source}/${encodeURIComponent(accountId)}${suffix}`

export const useConnectedMailDraft = (address: MailAddress | null) => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (input: ConnectedMailDraftCreateInput) => {
      if (!address) throw new Error('Choose a mailbox first.')
      return apiClient.post<ConnectedMailDraftResult>(mailMutationUrl(address, '/drafts'), input)
    },
  })
}

export const useUpdateConnectedMailDraft = (address: MailAddress | null) => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: ({ draftId, input }: { draftId: string; input: ConnectedMailComposeInput }) => {
      if (!address || address.source !== 'gmail') throw new Error('This provider draft cannot be updated.')
      return apiClient.patch<ConnectedMailDraftResult>(
        mailMutationUrl(address, `/drafts/${encodeURIComponent(draftId)}`), input,
      )
    },
  })
}

export const useConnectedMailSend = (address: MailAddress | null) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ConnectedMailboxSendInput | { draftId: string; expectedFingerprint?: string }) => {
      if (!address) throw new Error('Choose a mailbox first.')
      return apiClient.post<ConnectedMailDraftResult>(mailMutationUrl(address, '/send'), input)
    },
    // The action identity becomes ambiguous before the request crosses the
    // network. Seed the content-free status cache as locked, then replace it
    // with the server-held deadline on success. A lost response stays locked
    // and polls rather than exposing a resend doorway.
    onMutate: async (input) => {
      if (address?.source !== 'gmail' || !('draftId' in input)) return
      await queryClient.cancelQueries({ queryKey: gmailKeys.draftStatus(input.draftId) })
      queryClient.setQueryData<GmailDraftActionStatus>(gmailKeys.draftStatus(input.draftId), {
        id: input.draftId, sendAfter: null, state: 'dispatching',
      })
    },
    onSuccess: (data, input) => {
      void queryClient.invalidateQueries({ queryKey: connectedMailKeys.accounts() })
      if (address?.source !== 'gmail' || !('draftId' in input)) return
      if (data.status === 'sending' && data.sendAfter) {
        queryClient.setQueryData<GmailDraftActionStatus>(gmailKeys.draftStatus(input.draftId), {
          id: input.draftId, sendAfter: data.sendAfter, state: 'sending',
        })
        return
      }
      if (data.status === 'sent') {
        queryClient.setQueryData<GmailDraftActionStatus>(gmailKeys.draftStatus(input.draftId), {
          id: input.draftId, sendAfter: null, state: 'sent',
        })
        return
      }
      void queryClient.invalidateQueries({ queryKey: gmailKeys.draftStatus(input.draftId) })
    },
  })
}

/** The durable SMTP action is content-free; this read never retains mail data. */
export const useMailboxSendActionStatus = (
  address: MailAddress | null,
  actionId: string | undefined,
) => {
  const apiClient = useApiClient()
  return useQuery<MailboxSendActionStatus>({
    enabled: Boolean(address?.source === 'mailbox' && actionId),
    queryKey: connectedMailKeys.sendAction(address, actionId),
    queryFn: async () => {
      if (!address || address.source !== 'mailbox' || !actionId) {
        throw new Error('Choose a mailbox send action.')
      }
      return apiClient.get<MailboxSendActionStatus>(
        mailMutationUrl(address, `/send-actions/${encodeURIComponent(actionId)}`),
      )
    },
    // A dispatch is a live durable action. Poll only while it remains live;
    // the server's stale-claim sweep terminalizes it as delivery_unknown, so
    // this cannot leave a recovered composer frozen on a success claim.
    refetchInterval: (query) => query.state.data?.state === 'dispatching' ? 2_000 : false,
    staleTime: 0,
  })
}

export const useConnectedMailUndo = (address: MailAddress | null) => {
  const apiClient = useApiClient()
  return useMutation({
    mutationFn: (draftId: string) => {
      if (!address || address.source !== 'gmail') throw new Error('This send cannot be undone.')
      return apiClient.post<{ state: string }>(`/api/gmail/drafts/${encodeURIComponent(draftId)}/undo`, {})
    },
  })
}
