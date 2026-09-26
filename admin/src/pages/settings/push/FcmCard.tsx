import { useState, type ChangeEvent, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FcmStatus, PushCredentialResult, PushTestResult } from '@nessie/schemas'
import {
  useDeletePushCredential,
  useTestPush,
  useUploadFcm,
} from '../../../facades/platform-push/hooks'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { PushResultBanner, PushStatusRow } from './push-status'

type FcmCardProps = {
  status: FcmStatus | { configured: false } | undefined
}

export const FcmCard = ({ status }: FcmCardProps) => {
  const { t } = useTranslation('settings')
  const upload = useUploadFcm()
  const test = useTestPush()
  const remove = useDeletePushCredential()

  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<PushCredentialResult | PushTestResult | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const configured = status?.configured === true

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null)
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!file) return
    setResult(null)
    try {
      setResult(await upload.mutateAsync({ file }))
    } catch (error) {
      setResult({ provider: 'fcm', ok: false, message: (error as Error).message })
    }
  }

  const onTest = async () => {
    setResult(null)
    try {
      setResult(await test.mutateAsync({ provider: 'fcm' }))
    } catch (error) {
      setResult({ provider: 'fcm', ok: false, message: (error as Error).message })
    }
  }

  const onRemove = async () => {
    setResult(null)
    setConfirmingRemove(false)
    try {
      setResult(await remove.mutateAsync('fcm'))
    } catch (error) {
      setResult({ provider: 'fcm', ok: false, message: (error as Error).message })
    }
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>{t('push.google')}</SectionLabel>

      {status?.configured && (
        <div className="mt-3 grid gap-1.5 rounded-md bg-[color:var(--main-hover)] p-3 text-sm">
          <div className="font-semibold text-[color:var(--accent)]">{t('push.configured')} ✓</div>
          <PushStatusRow label={t('push.projectId')} value={status.projectId} />
          <PushStatusRow label={t('push.clientEmail')} value={status.clientEmail} />
          <PushStatusRow
            label={t('push.updated')}
            value={new Date(status.updatedAt).toLocaleString()}
          />
        </div>
      )}

      <form className="mt-4 grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.serviceAccount')}</span>
          <input accept=".json,application/json" onChange={onFileChange} type="file" />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            className="admin-button admin-button-primary"
            disabled={!file || upload.isPending}
            type="submit"
          >
            {upload.isPending ? t('common.saving') : t('push.save')}
          </button>
          {configured && (
            <>
              <button
                className="admin-button admin-button-secondary"
                disabled={test.isPending}
                onClick={() => void onTest()}
                type="button"
              >
                {t('push.validate')}
              </button>
              <button
                className="admin-button admin-button-secondary"
                disabled={remove.isPending}
                onClick={() => setConfirmingRemove(true)}
                type="button"
              >
                {t('common.remove')}
              </button>
            </>
          )}
        </div>
      </form>

      <PushResultBanner result={result} />

      <ConfirmDialog
        body={t('push.removeFcmBody')}
        confirmLabel={t('common.remove')}
        destructive
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void onRemove()}
        open={confirmingRemove}
        pending={remove.isPending}
        title={t('push.removeFcmTitle')}
      />
    </section>
  )
}
