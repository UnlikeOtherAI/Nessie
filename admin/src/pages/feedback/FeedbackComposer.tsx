import { useEffect, useRef, useState } from 'react'
import { Card } from '../../components/shared/Card'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Textarea } from '../../components/shared/FormControls'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { EMPTY_FORM_ERRORS, toFormErrors, type FormErrors } from '../../facades/forms/form-errors'
import { useCreateFeedback } from '../../facades/feedback/hooks'
import { uploadAttachment } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useShakeFeedback } from '../../providers/ShakeFeedbackContext'

export const FeedbackComposer = ({ onSubmitted }: { onSubmitted: () => void }) => {
  const { token } = useAuthSession()
  const createFeedback = useCreateFeedback()
  const { screenshot, setScreenshot } = useShakeFeedback()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [formErrors, setFormErrors] = useState<FormErrors>(EMPTY_FORM_ERRORS)

  const busy = submitting || createFeedback.isPending
  const canSubmit = title.trim().length > 0 && body.trim().length > 0 && !busy

  // A device shake delivers a screenshot via the native shell bridge; pick it up
  // as the attachment and clear it from the shared context.
  useEffect(() => {
    if (screenshot) {
      setFile(screenshot)
      setScreenshot(null)
    }
  }, [screenshot, setScreenshot])

  // Build an object URL so image attachments (screenshots, etc.) preview inline.
  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null
    event.target.value = ''
    setFile(next)
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFormErrors(EMPTY_FORM_ERRORS)
    try {
      let attachmentId: string | null = null
      if (file) {
        const attachment = await uploadAttachment(file, token)
        attachmentId = attachment.id
      }
      await createFeedback.mutateAsync({ title: title.trim(), body: body.trim(), attachmentId })
      setTitle('')
      setBody('')
      setFile(null)
      onSubmitted()
    } catch (submitError) {
      setFormErrors(toFormErrors(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card variant="section">
      <form onSubmit={handleSubmit}>
        <SectionLabel>Send feedback</SectionLabel>
        <div className="mt-2 text-sm text-[color:var(--tx2)]">
          Tell us what&apos;s working or what&apos;s not. Your feedback is filed as a GitHub issue.
        </div>

        <FormField className="mt-4" error={formErrors.fieldErrors.title} label="Title" required>
          <Input
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Short summary"
            type="text"
            value={title}
          />
        </FormField>

        <FormField className="mt-3" error={formErrors.fieldErrors.body} label="Details" required>
          <Textarea
            className="min-h-[120px]"
            maxLength={20000}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What happened, what did you expect, steps to reproduce…"
            value={body}
          />
        </FormField>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            className="admin-button admin-button-secondary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {file ? 'Change attachment' : 'Attach file'}
          </button>
          {file && (
            <div className="flex items-center gap-2">
              {previewUrl && (
                <img
                  alt="Attachment preview"
                  className="h-14 w-14 rounded-md border border-[color:var(--sep)] object-cover"
                  src={previewUrl}
                />
              )}
              <span className="text-xs text-[color:var(--tx2)]">
                {previewUrl ? file.name : `📎 ${file.name}`}
                <button
                  className="ml-2 text-[color:var(--lnk)] hover:underline"
                  onClick={() => setFile(null)}
                  type="button"
                >
                  remove
                </button>
              </span>
            </div>
          )}
          <input className="hidden" onChange={handleFileChange} ref={inputRef} type="file" />
        </div>

        <FormError className="mt-3">{formErrors.formError}</FormError>

        <FormActions className="mt-4">
          <button className="admin-button admin-button-primary" disabled={!canSubmit} type="submit">
            {busy ? 'Sending…' : 'Send feedback'}
          </button>
        </FormActions>
      </form>
    </Card>
  )
}
