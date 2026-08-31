import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { knowledgeKeys } from '../../lib/query-keys'
import { useApiClient } from '../../providers/ApiClientProvider'

export type KnowledgeVersionRecord = {
  id: string
  pageId: string
  versionNumber: number
  body: string | null
  bodyRef: string | null
  attachmentId: string | null
  authorType: 'user' | 'agent'
  authorId: string
  changeComment: string | null
  createdAt: string
  sourceRef: string
  visibilityReason: string
  policyChainTrace: string[]
}

export type KnowledgePageKind = 'document' | 'file'

export type KnowledgeSpaceRecord = {
  id: string
  ownerAgentId: string | null
  name: string
  description: string | null
  // Server-set space metadata. `personal: true` marks the caller's own
  // "My Docs" space, provisioned by the my-docs ensure endpoint.
  metadata: Record<string, unknown> | null
  projectId: string
  visibility: 'private' | 'channel' | 'team' | 'project' | 'organization'
  sensitivityTier: 'normal' | 'sensitive' | 'restricted'
  writeRestricted: boolean
  canWrite: boolean
  memberUserIds: string[]
  memberAgentIds: string[]
  sourceRef: string
  visibilityReason: string
  policyChainTrace: string[]
  createdAt: string
  updatedAt: string
}

export type KnowledgePageRecord = {
  id: string
  spaceId: string
  title: string
  summary: string | null
  kind: KnowledgePageKind
  metadata: Record<string, unknown> | null
  parentPageId: string | null
  position: number
  status: 'draft' | 'published' | 'archived'
  labels: string[]
  latestVersion: KnowledgeVersionRecord | null
  publishedVersion: KnowledgeVersionRecord | null
  publishedVersionId: string | null
  childPageIds?: string[]
  sourceRef: string
  visibilityReason: string
  policyChainTrace: string[]
  createdAt: string
  updatedAt: string
}

type CreateSpaceInput = {
  name: string
  description?: string | null
  projectId?: string
  visibility?: KnowledgeSpaceRecord['visibility']
  sensitivityTier?: KnowledgeSpaceRecord['sensitivityTier']
  memberAgentIds?: string[]
}

export type UpdateSpaceInput = {
  spaceId: string
  name?: string
  description?: string | null
  memberAgentIds?: string[]
  memberUserIds?: string[]
  writeRestricted?: boolean
}

export type SavePageInput = {
  body?: string | null
  changeComment?: string | null
  labels?: string[]
  metadata?: Record<string, unknown> | null
  parentPageId?: string | null
  summary?: string | null
  title: string
}

export type EnsureMyDocsResponse = { spaceId: string }

const invalidateKnowledge = (
  queryClient: ReturnType<typeof useQueryClient>,
  input: { pageId?: string; spaceId?: string } = {},
) => {
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.spaces })
  if (input.spaceId) void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(input.spaceId) })
  if (input.pageId) {
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.page(input.pageId) })
    void queryClient.invalidateQueries({ queryKey: knowledgeKeys.versions(input.pageId) })
  }
}

// Org-wide by default (the Knowledge section). Pass a projectId for a
// project's own Documents tab: the API narrows the list to that project on top
// of the caller's per-space read access.
export const useKnowledgeSpaces = (projectId?: string, enabled = true) => {
  const apiClient = useApiClient()
  const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''

  return useQuery<KnowledgeSpaceRecord[]>({
    enabled,
    queryKey: knowledgeKeys.scopedSpaces(projectId),
    queryFn: () => apiClient.get(`/api/knowledge-base/spaces?limit=100${scope}`),
  })
}

export const useKnowledgeSpace = (spaceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeSpaceRecord>({
    enabled: Boolean(spaceId),
    queryKey: knowledgeKeys.space(spaceId),
    queryFn: () => apiClient.get(`/api/knowledge-base/spaces/${spaceId}`),
  })
}

export const useKnowledgePages = (spaceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageRecord[]>({
    queryKey: knowledgeKeys.pages(spaceId),
    queryFn: () => apiClient.get(`/api/knowledge-base/spaces/${spaceId}/pages`),
    enabled: Boolean(spaceId),
  })
}

export const useKnowledgePage = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageRecord>({
    queryKey: knowledgeKeys.page(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}`),
    enabled: Boolean(pageId),
  })
}

// Imperative counterpart to useKnowledgePage: resolves a page (and, crucially,
// its owning spaceId) on demand from just a pageId — used by pageId-only deep
// links (e.g. a DeepWater research run's `knowledgePageId`) that don't know
// which space the page lives in ahead of time. Shares the same cache entry as
// useKnowledgePage via fetchQuery, so a page opened this way is not re-fetched
// once the workspace subsequently renders it.
export const useKnowledgePageLookup = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (pageId: string) =>
      queryClient.fetchQuery({
        queryKey: knowledgeKeys.page(pageId),
        queryFn: () => apiClient.get<KnowledgePageRecord>(`/api/knowledge-base/pages/${pageId}`),
      }),
  })
}

export const useKnowledgeVersions = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeVersionRecord[]>({
    queryKey: knowledgeKeys.versions(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/versions`),
    enabled: Boolean(pageId),
  })
}

// Idempotent "ensure my personal space" call — provisions (or fetches) the
// caller's private "My Docs" space. staleTime: Infinity because the result
// never changes for the session; we only need to call it once per mount.
// `enabled` is false on project-scoped surfaces, which have no business
// provisioning the caller's personal space.
export const useEnsureMyDocsSpace = (enabled = true) => {
  const apiClient = useApiClient()

  return useQuery<EnsureMyDocsResponse>({
    queryKey: knowledgeKeys.myDocs,
    queryFn: () => apiClient.post('/api/knowledge-base/my-docs', {}),
    staleTime: Infinity,
    enabled,
  })
}

export const useCreateKnowledgeSpace = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateSpaceInput) =>
      apiClient.post<KnowledgeSpaceRecord>('/api/knowledge-base/spaces', input),
    onSuccess: () => invalidateKnowledge(queryClient),
  })
}

export const useUpdateKnowledgeSpace = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: UpdateSpaceInput) => {
      const { spaceId, ...body } = input
      return apiClient.patch<KnowledgeSpaceRecord>(`/api/knowledge-base/spaces/${spaceId}`, body)
    },
    onSuccess: (space) => invalidateKnowledge(queryClient, { spaceId: space.id }),
  })
}

type SeedKnowledgeInput = {
  body: string
  projectId?: string
  spaceName: string
  summary?: string | null
  title: string
}

// Creates a space and seeds it with a single page in one shot — used to
// bootstrap an empty knowledge base on first visit.
export const useSeedKnowledgeBase = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: SeedKnowledgeInput) => {
      const space = await apiClient.post<KnowledgeSpaceRecord>('/api/knowledge-base/spaces', {
        name: input.spaceName,
        projectId: input.projectId,
      })
      await apiClient.post<KnowledgePageRecord>(
        `/api/knowledge-base/spaces/${space.id}/pages`,
        { body: input.body, summary: input.summary ?? null, title: input.title },
      )
      return space
    },
    onSuccess: () => invalidateKnowledge(queryClient),
  })
}

export const useCreateKnowledgePage = (spaceId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SavePageInput) =>
      apiClient.post<KnowledgePageRecord>(`/api/knowledge-base/spaces/${spaceId}/pages`, input),
    onSuccess: (page) => invalidateKnowledge(queryClient, { pageId: page.id, spaceId }),
  })
}

export const useUpdateKnowledgePage = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: SavePageInput & { pageId: string }) => {
      const { pageId, ...body } = input
      return apiClient.patch<KnowledgePageRecord>(`/api/knowledge-base/pages/${pageId}`, body)
    },
    onSuccess: (page) => invalidateKnowledge(queryClient, { pageId: page.id, spaceId: page.spaceId }),
  })
}

export const usePublishKnowledgePage = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { pageId: string }) =>
      apiClient.post<KnowledgePageRecord>(`/api/knowledge-base/pages/${input.pageId}/publish`, {}),
    onSuccess: (page) => invalidateKnowledge(queryClient, { pageId: page.id, spaceId: page.spaceId }),
  })
}

export const useRestoreKnowledgeVersion = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { pageId: string; versionId: string; changeComment?: string }) =>
      apiClient.post<KnowledgePageRecord>(
        `/api/knowledge-base/pages/${input.pageId}/versions/${input.versionId}/restore`,
        { changeComment: input.changeComment },
      ),
    onSuccess: (page) => invalidateKnowledge(queryClient, { pageId: page.id, spaceId: page.spaceId }),
  })
}
