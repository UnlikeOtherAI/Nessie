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

export type ConnectedMailPage<T> = {
  items: T[]
  nextCursor?: string
  previousCursor?: string
  estimate?: number
}

export type MailAddress = { accountId: string; source: ConnectedMailSource }

export const mailPath = ({ accountId, source }: MailAddress): string =>
  `/mail/${source}/${encodeURIComponent(accountId)}`

export const connectedMailKeys = {
  accounts: () => ['connected-mail', 'accounts'] as const,
  conversation: ({ accountId, source }: MailAddress, threadId: string | undefined) =>
    ['connected-mail', 'conversation', source, accountId, threadId] as const,
  threads: (
    { accountId, source }: MailAddress,
    input: { cursor?: string; pageSize: number; query: string; unreadOnly: boolean },
  ) => ['connected-mail', 'threads', source, accountId, input] as const,
}

export const useConnectedMailAccounts = () => {
  const apiClient = useApiClient()
  return useQuery<ConnectedMailAccountRecord[]>({
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

export type ConnectedMailDraftResult = { id: string; contentFingerprint?: string; sendAfter?: string; status?: string }

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
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: connectedMailKeys.accounts() }) },
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
