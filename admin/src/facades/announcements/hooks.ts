import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { uploadFileWithProgress } from '../../lib/upload-xhr'

export type Banner = {
  id: string
  text: string
  linkUrl: string | null
  active: boolean
  revision: string
  updatedAt: string
}

export type NewsArticle = {
  id: string
  title: string
  body: string
  imageUrl: string | null
  youtubeUrl: string | null
  youtubeId: string | null
  publishedAt: string | null
  publicationVersion: number | null
  createdAt: string
  updatedAt: string
}

export type NewsFeed = {
  articles: NewsArticle[]
  unreadCount: number
  notificationsMuted: boolean
}

export type ArticleInput = {
  title: string
  body: string
  imageUrl: string | null
  youtubeUrl: string | null
  published: boolean
}

type OperatorAnnouncements = { banner: Banner | null; articles: NewsArticle[] }

const keys = {
  banner: ['platform-announcements', 'banner'] as const,
  news: ['platform-announcements', 'news'] as const,
  newsForUser: (userId: string | undefined) => ['platform-announcements', 'news', userId] as const,
  operator: ['platform-announcements', 'operator'] as const,
}

export const useBanner = () => {
  const apiClient = useApiClient()
  return useQuery<Banner | null>({
    queryKey: keys.banner,
    queryFn: () => apiClient.get('/api/announcements/banner'),
    refetchInterval: 60_000,
  })
}

export const useNews = () => {
  const apiClient = useApiClient()
  const { me } = useAuthSession()
  return useQuery<NewsFeed>({
    queryKey: keys.newsForUser(me?.user.id),
    queryFn: () => apiClient.get('/api/news'),
    enabled: Boolean(me?.user.id),
    refetchInterval: 30_000,
  })
}

export const useMarkNewsRead = () => {
  const apiClient = useApiClient()
  const cache = useQueryClient()
  const { me } = useAuthSession()
  const queryKey = keys.newsForUser(me?.user.id)
  return useMutation({
    mutationFn: (throughVersion: number) => apiClient.post('/api/news/read', { throughVersion }),
    onMutate: async () => {
      await cache.cancelQueries({ queryKey })
      const previous = cache.getQueryData<NewsFeed>(queryKey)
      cache.setQueryData<NewsFeed>(queryKey, (current) => current
        ? { ...current, unreadCount: 0 } : current)
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) cache.setQueryData(queryKey, context.previous)
    },
    onSuccess: () => { void cache.invalidateQueries({ queryKey: keys.news }) },
  })
}

export const useSetNewsMuted = () => {
  const apiClient = useApiClient()
  const cache = useQueryClient()
  const { me } = useAuthSession()
  const queryKey = keys.newsForUser(me?.user.id)
  return useMutation({
    mutationFn: (notificationsMuted: boolean) =>
      apiClient.patch('/api/news/preferences', { notificationsMuted }),
    onMutate: async (notificationsMuted) => {
      await cache.cancelQueries({ queryKey })
      const previous = cache.getQueryData<NewsFeed>(queryKey)
      cache.setQueryData<NewsFeed>(queryKey, (current) => current
        ? { ...current, notificationsMuted } : current)
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) cache.setQueryData(queryKey, context.previous)
    },
    onSuccess: () => { void cache.invalidateQueries({ queryKey: keys.news }) },
  })
}

export const useOperatorAnnouncements = (enabled: boolean) => {
  const apiClient = useApiClient()
  return useQuery<OperatorAnnouncements>({
    queryKey: keys.operator,
    queryFn: () => apiClient.get('/api/platform/announcements'),
    enabled,
  })
}

export const useSaveBanner = () => {
  const apiClient = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: Pick<Banner, 'text' | 'linkUrl' | 'active'>) =>
      apiClient.put<Banner>('/api/platform/announcements/banner', input),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: keys.operator })
      void cache.invalidateQueries({ queryKey: keys.banner })
    },
  })
}

export const useSaveArticle = () => {
  const apiClient = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: ArticleInput }) =>
      id
        ? apiClient.put<NewsArticle>(`/api/platform/announcements/news/${id}`, input)
        : apiClient.post<NewsArticle>('/api/platform/announcements/news', input),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: keys.operator })
      void cache.invalidateQueries({ queryKey: keys.news })
    },
  })
}

export const useUploadNewsImage = () => {
  const { token } = useAuthSession()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      uploadFileWithProgress<{ imageUrl: string }>(
        `/api/platform/announcements/news/${id}/image`, file, token,
      ),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: keys.operator })
      void cache.invalidateQueries({ queryKey: keys.news })
    },
  })
}

export const useDeleteArticle = () => {
  const apiClient = useApiClient()
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/api/platform/announcements/news/${id}`),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: keys.operator })
      void cache.invalidateQueries({ queryKey: keys.news })
    },
  })
}
