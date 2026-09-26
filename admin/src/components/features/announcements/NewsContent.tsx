import { useEffect, useState } from 'react'
import {
  useMarkNewsRead,
  useNews,
  useSetNewsMuted,
  type NewsArticle,
} from '../../../facades/announcements/hooks'
import { useAuthedObjectUrlFromPath } from '../../../lib/uploads'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

const NewsArticleItem = ({ article }: { article: NewsArticle }) => {
  const { token } = useAuthSession()
  const [playing, setPlaying] = useState(false)
  const imagePath = article.imageUrl?.startsWith('/api/news/')
    ? `${article.imageUrl}?v=${encodeURIComponent(article.updatedAt)}` : null
  const uploadedImage = useAuthedObjectUrlFromPath(imagePath, token)
  const poster = uploadedImage ?? (imagePath ? null : article.imageUrl)
    ?? (article.youtubeId ? `https://i.ytimg.com/vi/${article.youtubeId}/hqdefault.jpg` : null)

  return (
    <li className="py-6 first:pt-2">
      <article>
        <time className="text-xs text-[color:var(--tx3)]" dateTime={article.publishedAt ?? undefined}>
          {article.publishedAt ? new Date(article.publishedAt).toLocaleDateString() : ''}
        </time>
        <h2 className="mt-1 text-xl font-semibold text-[color:var(--tx)]">{article.title}</h2>
        {article.youtubeId && playing ? (
          <div className="mt-4 aspect-video overflow-hidden rounded-lg">
            <iframe
              allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="h-full w-full"
              referrerPolicy="strict-origin-when-cross-origin"
              src={`https://www.youtube-nocookie.com/embed/${article.youtubeId}?autoplay=1`}
              title={article.title}
            />
          </div>
        ) : article.youtubeId && poster ? (
          <button
            aria-label={`Play ${article.title}`}
            className="news-media relative mt-4 block w-full overflow-hidden rounded-lg"
            onClick={() => setPlaying(true)}
            type="button"
          >
            <img alt="" className="aspect-video w-full object-cover" loading="lazy" src={poster} />
            <span aria-hidden="true" className="news-play-button">▶</span>
          </button>
        ) : poster ? (
          <img alt={`${article.title} image`} className="mt-4 aspect-video w-full rounded-lg object-cover"
            loading="lazy" src={poster} />
        ) : null}
        {article.body && (
          <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-[color:var(--tx2)]">
            {article.body}
          </p>
        )}
      </article>
    </li>
  )
}

export const NewsContent = () => {
  const news = useNews()
  const { mutate: markRead } = useMarkNewsRead()
  const mute = useSetNewsMuted()
  const [pendingMute, setPendingMute] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const latestVersion = news.data?.articles[0]?.publicationVersion ?? 0

  // Opening this surface is the acknowledgement for the account, across every
  // device and organisation. Publications arriving while it stays open are
  // read as they appear here, without re-acknowledging every poll result.
  useEffect(() => {
    if (news.isSuccess) {
      markRead(latestVersion, {
        onError: () => setError('Could not mark News as read. Please reopen it to try again.'),
      })
    }
  }, [latestVersion, markRead, news.isSuccess])

  if (news.isPending) return <p className="py-8 text-center text-[color:var(--tx3)]">Loading news…</p>
  if (news.isError) return <p className="py-8 text-center text-[color:var(--tx3)]">News could not be loaded.</p>

  return (
    <div className="mx-auto w-full max-w-2xl px-[var(--page-gutter)] py-5">
      <div className="mb-4 flex items-center justify-between gap-4 border-b border-[color:var(--sep)] pb-4">
        <span className="text-sm text-[color:var(--tx2)]">Updates for everyone using Nessie</span>
        <label className="flex shrink-0 items-center gap-2 text-sm text-[color:var(--tx)]">
          <input
            checked={pendingMute ?? news.data.notificationsMuted}
            disabled={mute.isPending}
            onChange={(event) => {
              const next = event.target.checked
              setError(null)
              setPendingMute(next)
              mute.mutate(next, {
                onError: () => setError('Could not save the notification setting. Please try again.'),
                onSettled: () => setPendingMute(null),
              })
            }}
            type="checkbox"
          />
          Mute notifications
        </label>
      </div>
      {error && <p className="mb-4 text-sm text-[color:var(--danger)]" role="alert">{error}</p>}
      {news.data.articles.length === 0 ? (
        <p className="py-12 text-center text-[color:var(--tx3)]">No news yet.</p>
      ) : (
        <ol className="divide-y divide-[color:var(--sep)]">
          {news.data.articles.map((article) => <NewsArticleItem article={article} key={article.id} />)}
        </ol>
      )}
    </div>
  )
}
