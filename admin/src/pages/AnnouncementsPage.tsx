import { useState, type FormEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { TabBar } from '../components/primitives/TabBar'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { FormActions, FormError, FormSuccess } from '../components/shared/FormActions'
import { FormField } from '../components/shared/FormField'
import { Input, Textarea } from '../components/shared/FormControls'
import { SettingsPanel } from '../components/shared/SettingsPanel'
import { SuperAdminGate, useIsSuperAdmin } from '../components/shared/SuperAdminGate'
import {
  useDeleteArticle,
  useOperatorAnnouncements,
  useSaveArticle,
  useSaveBanner,
  useUploadNewsImage,
  type ArticleInput,
  type Banner,
  type NewsArticle,
} from '../facades/announcements/hooks'
import { useTabParam } from '../navigation/useTabParam'

const TABS = ['strip', 'news'] as const
type AnnouncementsTab = (typeof TABS)[number]

const BannerEditor = ({ banner }: { banner: Banner | null }) => {
  const [text, setText] = useState(banner?.text ?? '')
  const [linkUrl, setLinkUrl] = useState(banner?.linkUrl ?? '')
  const [active, setActive] = useState(banner?.active ?? false)
  const [feedback, setFeedback] = useState<{ error?: string; success?: string }>({})
  const save = useSaveBanner()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFeedback({})
    try {
      await save.mutateAsync({ text, linkUrl: linkUrl.trim() || null, active })
      setFeedback({ success: 'The strip is saved for this installation.' })
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : 'Could not save the strip.' })
    }
  }

  return (
    <form className="grid max-w-2xl gap-5" onSubmit={(event) => void submit(event)}>
      <p className="text-sm text-[color:var(--tx2)]">
        A short message above the app. Each device can dismiss this version permanently.
      </p>
      <FormField label="Strip text" required>
        <Input maxLength={240} onChange={(event) => setText(event.target.value)} value={text} />
      </FormField>
      <FormField help="Use a Nessie path such as /projects, or an external URL. The entire strip opens it."
        label="Link (optional)">
        <Input onChange={(event) => setLinkUrl(event.target.value)} type="text" value={linkUrl} />
      </FormField>
      <label className="flex items-center gap-2 text-sm text-[color:var(--tx)]">
        <input checked={active} onChange={(event) => setActive(event.target.checked)} type="checkbox" />
        Show this strip to everyone
      </label>
      <FormError>{feedback.error}</FormError>
      <FormSuccess>{feedback.success}</FormSuccess>
      <FormActions>
        <button className="admin-button admin-button-primary" disabled={save.isPending} type="submit">
          {save.isPending ? 'Saving…' : 'Save strip'}
        </button>
      </FormActions>
    </form>
  )
}

const EMPTY_ARTICLE: ArticleInput = {
  title: '', body: '', imageUrl: null, youtubeUrl: null, published: false,
}

const NewsEditor = ({
  article,
  onDeleted,
  onSaved,
  successMessage,
}: {
  article: NewsArticle | null
  onDeleted: () => void
  onSaved: (id: string, published: boolean) => void
  successMessage: string | null
}) => {
  const [currentId, setCurrentId] = useState(article?.id ?? null)
  const [draft, setDraft] = useState<ArticleInput>(() => article ? {
    title: article.title,
    body: article.body,
    imageUrl: article.imageUrl,
    youtubeUrl: article.youtubeUrl,
    published: article.publishedAt !== null,
  } : EMPTY_ARTICLE)
  const [feedback, setFeedback] = useState<{ error?: string }>({})
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [fileInputVersion, setFileInputVersion] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const save = useSaveArticle()
  const uploadImage = useUploadNewsImage()
  const remove = useDeleteArticle()
  const patch = (next: Partial<ArticleInput>) => setDraft((current) => ({ ...current, ...next }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setFeedback({})
    try {
      let input = draft
      let uploadAfterCreate = imageFile
      if (currentId && imageFile) {
        const uploaded = await uploadImage.mutateAsync({ id: currentId, file: imageFile })
        input = { ...draft, imageUrl: uploaded.imageUrl }
        setDraft(input)
        setImageFile(null)
        setFileInputVersion((version) => version + 1)
        uploadAfterCreate = null
      }
      const publishAfterUpload = Boolean(uploadAfterCreate && input.published)
      const saved = await save.mutateAsync({
        id: currentId,
        input: publishAfterUpload ? { ...input, published: false } : input,
      })
      setCurrentId(saved.id)
      if (uploadAfterCreate) {
        const uploaded = await uploadImage.mutateAsync({ id: saved.id, file: uploadAfterCreate })
        const completedDraft = { ...input, imageUrl: uploaded.imageUrl }
        setDraft(completedDraft)
        setImageFile(null)
        setFileInputVersion((version) => version + 1)
        if (publishAfterUpload) {
          await save.mutateAsync({ id: saved.id, input: completedDraft })
        }
      }
      onSaved(saved.id, draft.published)
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : 'Could not save the article.' })
    }
  }

  const deleteArticle = async () => {
    if (!currentId) return
    try {
      await remove.mutateAsync(currentId)
      setConfirmDelete(false)
      onDeleted()
    } catch (error) {
      setConfirmDelete(false)
      setFeedback({ error: error instanceof Error ? error.message : 'Could not delete the article.' })
    }
  }

  return (
    <>
      <form className="grid min-w-0 gap-4" onSubmit={(event) => void submit(event)}>
        <h2 className="text-lg font-semibold text-[color:var(--tx)]">
          {currentId ? 'Edit article' : 'New article'}
        </h2>
        <FormField label="Header" required>
          <Input maxLength={180} onChange={(event) => patch({ title: event.target.value })}
            required value={draft.title} />
        </FormField>
        <FormField help="Write text, add an image, or link a video before publishing." label="Text">
          <Textarea onChange={(event) => patch({ body: event.target.value })}
            rows={9} value={draft.body} />
        </FormField>
        <FormField help="Paste a public image URL. If a YouTube link is set, this image becomes its preview."
          label="Image URL (optional)">
          <Input onChange={(event) => patch({ imageUrl: event.target.value || null })}
            value={draft.imageUrl ?? ''} />
        </FormField>
        <FormField help="Or upload a PNG, JPEG, WebP or GIF up to 5 MB. The file replaces the image URL when saved."
          label="Image file (optional)">
          <Input accept="image/png,image/jpeg,image/webp,image/gif" key={fileInputVersion}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              if (file && file.size > 5 * 1024 * 1024) {
                setImageFile(null)
                setFeedback({ error: 'Choose an image smaller than 5 MB.' })
                event.target.value = ''
                return
              }
              setImageFile(file)
            }} type="file" />
        </FormField>
        <FormField help="A YouTube watch, short or youtu.be link. The player loads only after someone taps the image."
          label="YouTube link (optional)">
          <Input onChange={(event) => patch({ youtubeUrl: event.target.value || null })}
            value={draft.youtubeUrl ?? ''} />
        </FormField>
        <label className="flex items-center gap-2 text-sm text-[color:var(--tx)]">
          <input checked={draft.published} onChange={(event) => patch({ published: event.target.checked })}
            type="checkbox" />
          Published for everyone
        </label>
        <FormError>{feedback.error}</FormError>
        <FormSuccess>{successMessage}</FormSuccess>
        <FormActions destructive={currentId ? (
          <button className="admin-button admin-button-danger" onClick={() => setConfirmDelete(true)}
            type="button">Delete</button>
        ) : undefined}>
          <button className="admin-button admin-button-primary"
            disabled={save.isPending || uploadImage.isPending} type="submit">
            {save.isPending || uploadImage.isPending ? 'Saving…' : 'Save article'}
          </button>
        </FormActions>
      </form>
      <ConfirmDialog
        body="This removes the article from every account."
        confirmLabel="Delete article"
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void deleteArticle()}
        open={confirmDelete}
        pending={remove.isPending}
        title="Delete this article?"
      />
    </>
  )
}

export const AnnouncementsPage = () => {
  const isSuperAdmin = useIsSuperAdmin()
  const query = useOperatorAnnouncements(isSuperAdmin)
  const [tab, setTab] = useTabParam('tab', TABS, 'strip', { clears: ['article'] })
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const selectedId = searchParams.get('article')
  const setSelectedId = (id: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (id) next.set('article', id)
      else next.delete('article')
      return next
    }, { replace: true, state: location.state })
  }
  const [newArticleVersion, setNewArticleVersion] = useState(0)
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const articles = query.data?.articles ?? []
  const selected = articles.find((article) => article.id === selectedId) ?? null
  const tabs = (
    <TabBar<AnnouncementsTab> ariaLabel="Announcement types" items={[
      { label: 'Strip', value: 'strip' }, { label: 'News', value: 'news' },
    ]} onChange={setTab} value={tab} />
  )

  return (
    <SuperAdminGate>
      <SettingsPanel eyebrow="Advanced" tabs={tabs} title="Announcements">
        {query.isPending ? <p>Loading announcements…</p>
          : query.isError ? <p role="alert">Announcements could not be loaded.</p>
            : tab === 'strip' ? (
              <BannerEditor banner={query.data?.banner ?? null} />
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(180px,0.7fr)_minmax(0,1.3fr)]">
                <div className="min-w-0">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h2 className="font-semibold text-[color:var(--tx)]">Articles</h2>
                    <button className="admin-button admin-button-secondary admin-button-compact"
                      onClick={() => {
                        setSelectedId(null)
                        setSavedMessage(null)
                        setNewArticleVersion((version) => version + 1)
                      }} type="button">New article</button>
                  </div>
                  {articles.length === 0 ? <p className="text-sm text-[color:var(--tx3)]">No articles yet.</p> : (
                    <ul className="divide-y divide-[color:var(--sep)]">
                      {articles.map((article) => (
                        <li key={article.id}>
                          <button aria-current={selectedId === article.id ? 'true' : undefined}
                            className="w-full py-3 text-left hover:text-[color:var(--accent)]"
                            onClick={() => {
                              setSelectedId(article.id)
                              setSavedMessage(null)
                            }} type="button">
                            <span className="block font-medium">{article.title}</span>
                            <span className="text-xs text-[color:var(--tx3)]">
                              {article.publishedAt ? 'Published' : 'Draft'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="min-w-0 border-t border-[color:var(--sep)] pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                  <NewsEditor article={selected} key={selected?.id ?? `new-${newArticleVersion}`}
                    onSaved={(id, published) => {
                      setSelectedId(id)
                      setSavedMessage(published ? 'Article published.' : 'Draft saved.')
                    }}
                    onDeleted={() => {
                      setSelectedId(null)
                      setSavedMessage(null)
                      setNewArticleVersion((version) => version + 1)
                    }} successMessage={savedMessage} />
                </div>
              </div>
            )}
      </SettingsPanel>
    </SuperAdminGate>
  )
}
