import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  name: string
  description: string | null
  projectId: string
  visibility: 'private' | 'channel' | 'team' | 'project' | 'organization'
  sensitivityTier: 'normal' | 'sensitive' | 'restricted'
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
}

export type SavePageInput = {
  body?: string | null
  changeComment?: string | null
  labels?: string[]
  parentPageId?: string | null
  summary?: string | null
  title: string
}

const spacesKey = ['knowledge-spaces'] as const
const pagesKey = (spaceId?: string) => ['knowledge-pages', spaceId ?? 'none'] as const
const pageKey = (pageId?: string) => ['knowledge-page', pageId ?? 'none'] as const
const versionsKey = (pageId?: string) => ['knowledge-versions', pageId ?? 'none'] as const

const invalidateKnowledge = (
  queryClient: ReturnType<typeof useQueryClient>,
  input: { pageId?: string; spaceId?: string } = {},
) => {
  void queryClient.invalidateQueries({ queryKey: spacesKey })
  if (input.spaceId) void queryClient.invalidateQueries({ queryKey: pagesKey(input.spaceId) })
  if (input.pageId) {
    void queryClient.invalidateQueries({ queryKey: pageKey(input.pageId) })
    void queryClient.invalidateQueries({ queryKey: versionsKey(input.pageId) })
  }
}

export const useKnowledgeSpaces = () => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeSpaceRecord[]>({
    queryKey: spacesKey,
    queryFn: () => apiClient.get('/api/knowledge-base/spaces?limit=100'),
  })
}

export const useKnowledgePages = (spaceId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageRecord[]>({
    queryKey: pagesKey(spaceId),
    queryFn: () => apiClient.get(`/api/knowledge-base/spaces/${spaceId}/pages`),
    enabled: Boolean(spaceId),
  })
}

export const useKnowledgePage = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgePageRecord>({
    queryKey: pageKey(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}`),
    enabled: Boolean(pageId),
  })
}

export const useKnowledgeVersions = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<KnowledgeVersionRecord[]>({
    queryKey: versionsKey(pageId),
    queryFn: () => apiClient.get(`/api/knowledge-base/pages/${pageId}/versions`),
    enabled: Boolean(pageId),
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
