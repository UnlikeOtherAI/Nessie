import { useState, type ChangeEvent, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ApnsStatus,
  PushApnsEnvironment,
  PushCredentialResult,
  PushTestResult,
} from '@nessie/schemas'
import {
  useDeletePushCredential,
  useTestPush,
  useUploadApns,
} from '../../../facades/platform-push/hooks'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { ConfirmDialog } from '../../../components/shared/ConfirmDialog'
import { PushResultBanner, PushStatusRow } from './push-status'

// Derive a Key ID from an `AuthKey_<KEYID>.p8` filename, matching the server's
// auto-derivation so the field pre-fills on file pick.
const deriveKeyId = (filename: string): string => {
  const match = filename.match(/^AuthKey_([A-Za-z0-9]+)\.p8$/)
  return match?.[1] ?? ''
}

type ApnsCardProps = {
  status: ApnsStatus | { configured: false } | undefined
}

export const ApnsCard = ({ status }: ApnsCardProps) => {
  const { t } = useTranslation('settings')
  const upload = useUploadApns()
  const test = useTestPush()
  const remove = useDeletePushCredential()

  const [file, setFile] = useState<File | null>(null)
  const [keyId, setKeyId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [topic, setTopic] = useState('')
  const [environment, setEnvironment] = useState<PushApnsEnvironment>('production')
  const [result, setResult] = useState<PushCredentialResult | PushTestResult | null>(null)
  const [confirmingRemove, setConfirmingRemove] = useState(false)

  const configured = status?.configured === true

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null
    setFile(picked)
    if (picked) {
      const derived = deriveKeyId(picked.name)
      if (derived) setKeyId(derived)
    }
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!file) return
    setResult(null)
    try {
      const res = await upload.mutateAsync({
        file,
        keyId: keyId.trim() || undefined,
        teamId: teamId.trim(),
        topic: topic.trim(),
        environment,
      })
      setResult(res)
    } catch (error) {
      setResult({ provider: 'apns', ok: false, message: (error as Error).message })
    }
  }

  const onTest = async () => {
    setResult(null)
    try {
      setResult(await test.mutateAsync({ provider: 'apns' }))
    } catch (error) {
      setResult({ provider: 'apns', ok: false, message: (error as Error).message })
    }
  }

  const onRemove = async () => {
    setResult(null)
    setConfirmingRemove(false)
    try {
      setResult(await remove.mutateAsync('apns'))
    } catch (error) {
      setResult({ provider: 'apns', ok: false, message: (error as Error).message })
    }
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>{t('push.apple')}</SectionLabel>

      {status?.configured && (
        <div className="mt-3 grid gap-1.5 rounded-md bg-[color:var(--main-hover)] p-3 text-sm">
          <div className="font-semibold text-[color:var(--accent)]">{t('push.configured')} ✓</div>
          <PushStatusRow label={t('push.keyId')} value={status.keyId} />
          <PushStatusRow label={t('push.teamId')} value={status.teamId} />
          <PushStatusRow label={t('push.topic')} value={status.topic} />
          <PushStatusRow label={t('push.environment')} value={t(`push.environments.${status.environment}`)} />
          <PushStatusRow
            label={t('push.updated')}
            value={new Date(status.updatedAt).toLocaleString()}
          />
        </div>
      )}

      <form className="mt-4 grid gap-3" onSubmit={(event) => void onSubmit(event)}>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.signingKey')}</span>
          <input accept=".p8" onChange={onFileChange} type="file" />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.keyId')}</span>
          <input
            className="admin-input"
            onChange={(event) => setKeyId(event.target.value)}
            placeholder="ABC123DEFG"
            value={keyId}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.teamId')}</span>
          <input
            className="admin-input"
            onChange={(event) => setTeamId(event.target.value)}
            placeholder="TEAM123456"
            value={teamId}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.bundleId')}</span>
          <input
            className="admin-input"
            onChange={(event) => setTopic(event.target.value)}
            placeholder="com.example.app"
            value={topic}
          />
        </label>
        <label className="grid gap-1 text-sm text-[color:var(--tx2)]">
          <span>{t('push.environment')}</span>
          <select
            className="admin-input"
            onChange={(event) => setEnvironment(event.target.value as PushApnsEnvironment)}
            value={environment}
          >
            <option value="production">{t('push.environments.production')}</option>
            <option value="sandbox">{t('push.environments.sandbox')}</option>
          </select>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            className="admin-button admin-button-primary"
            disabled={!file || !teamId.trim() || !topic.trim() || upload.isPending}
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
                {t('push.sendTest')}
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
        body={t('push.removeApnsBody')}
        confirmLabel={t('common.remove')}
        destructive
        onCancel={() => setConfirmingRemove(false)}
        onConfirm={() => void onRemove()}
        open={confirmingRemove}
        pending={remove.isPending}
        title={t('push.removeApnsTitle')}
      />
    </section>
  )
}
