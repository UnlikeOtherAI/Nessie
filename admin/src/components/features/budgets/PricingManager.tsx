import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { budgetKeys, opsTelemetryKeys } from '../../../lib/query-keys'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { QueryState } from '../../shared/QueryState'

export type PricingProfile = {
  profileId: string
  provider: string
  modelPattern: string
  currency: string
  source: string
  inputPerMillion: number | null
  outputPerMillion: number | null
  cachedInputPerMillion: number | null
  cachedOutputPerMillion: number | null
  cacheReadPerMillion: number | null
  cacheWritePerMillion: number | null
  effectiveFrom: string
  effectiveTo: string | null
}

const parseRate = (raw: string): number | null | 'invalid' => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return value
}

const rate = (value: number | null, locale: string): string => (value == null
  ? '—'
  : `${new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(value)}/M`)

export const PricingManager = () => {
  const { t, i18n } = useTranslation('opsBudget')
  const locale = i18n.resolvedLanguage ?? 'en-GB'
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const profilesQuery = useQuery<PricingProfile[]>({
    queryKey: opsTelemetryKeys.pricingProfiles,
    queryFn: () => apiClient.get('/api/ledger/tokens/pricing'),
  })
  const profiles = profilesQuery.data ?? []
  const [pendingDelete, setPendingDelete] = useState<PricingProfile | null>(null)

  const [provider, setProvider] = useState('openai')
  const [modelPattern, setModelPattern] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [cacheRead, setCacheRead] = useState('')
  const [cacheWrite, setCacheWrite] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: opsTelemetryKeys.pricingProfiles })
    // Cost figures everywhere depend on pricing — refresh the summaries too.
    void queryClient.invalidateQueries({ queryKey: opsTelemetryKeys.tokenSummary })
    void queryClient.invalidateQueries({ queryKey: opsTelemetryKeys.tokenEstimate })
    void queryClient.invalidateQueries({ queryKey: budgetKeys.all })
  }

  const resetForm = () => {
    setModelPattern('')
    setInput('')
    setOutput('')
    setCacheRead('')
    setCacheWrite('')
  }

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiClient.post('/api/ledger/tokens/pricing', payload),
    onSuccess: () => {
      setFormError(null)
      resetForm()
      invalidate()
    },
    onError: () => setFormError(t('pricing.saveFailed')),
  })

  const remove = useMutation({
    mutationFn: (profileId: string) =>
      apiClient.delete(`/api/ledger/tokens/pricing/${profileId}`),
    onSuccess: () => {
      setPendingDelete(null)
      invalidate()
    },
  })

  // Re-price historical events that were logged before pricing existed (they
  // stay $0 because cost is computed at write time).
  const recompute = useMutation({
    mutationFn: () =>
      apiClient.post<{ updatedEvents: number; pricedPairs: number; unpricedPairs: number }>(
        '/api/ledger/tokens/recompute-costs',
        {},
      ),
    onSuccess: (r) => {
      setRecomputeMsg(
        t('pricing.repriced', {
          events: new Intl.NumberFormat(locale).format(r.updatedEvents),
          models: new Intl.NumberFormat(locale).format(r.pricedPairs),
        }) + (r.unpricedPairs ? t('pricing.unpriced', { count: r.unpricedPairs }) : ''),
      )
      invalidate()
    },
    onError: () => setRecomputeMsg(t('pricing.repriceFailed')),
  })

  const handleSave = () => {
    if (provider.trim() === '' || modelPattern.trim() === '') {
      setFormError(t('pricing.requiredFields'))
      return
    }
    const rates = {
      inputPerMillion: parseRate(input),
      outputPerMillion: parseRate(output),
      cacheReadPerMillion: parseRate(cacheRead),
      cacheWritePerMillion: parseRate(cacheWrite),
    }
    if (Object.values(rates).some((v) => v === 'invalid')) {
      setFormError(t('pricing.invalidRates'))
      return
    }
    setFormError(null)
    save.mutate({
      provider: provider.trim(),
      modelPattern: modelPattern.trim(),
      currency: 'USD',
      source: 'manual',
      ...rates,
    })
  }

  return (
    <div className="admin-card mt-4 p-4">
      <SectionLabel>{t('pricing.title')}</SectionLabel>
      <p className="mt-1 text-xs text-[color:var(--tx2)]">
        {t('pricing.descriptionBefore')}
        <code className="mx-1 rounded bg-[var(--overlay-weak)] px-1">*</code>
        {t('pricing.descriptionAfter')}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.provider')}
          <input
            className="admin-input mt-1"
            onChange={(e) => setProvider(e.target.value)}
            placeholder="openai"
            value={provider}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.modelPattern')}
          <input
            className="admin-input mt-1"
            onChange={(e) => setModelPattern(e.target.value)}
            placeholder={t('pricing.modelExample')}
            value={modelPattern}
          />
        </label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.inputRate')}
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setInput(e.target.value)} placeholder="0.25" value={input} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.outputRate')}
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setOutput(e.target.value)} placeholder="2.00" value={output} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.cacheReadRate')}
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setCacheRead(e.target.value)} placeholder="0.025" value={cacheRead} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          {t('pricing.cacheWriteRate')}
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setCacheWrite(e.target.value)} placeholder={t('pricing.optional')} value={cacheWrite} />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="admin-button admin-button-secondary" onClick={resetForm} type="button">
          {t('clear')}
        </button>
        <button
          className="admin-button admin-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
          type="button"
        >
          {t('pricing.save')}
        </button>
      </div>
      {formError && <div className="mt-2 text-xs text-[var(--danger-text)]">{formError}</div>}

      <div className="mt-5 flex items-center justify-between gap-2">
        <SectionLabel as="span">{t('pricing.configured', { count: profiles.length })}</SectionLabel>
        <button
          className="admin-button admin-button-secondary"
          disabled={recompute.isPending || profiles.length === 0}
          onClick={() => {
            setRecomputeMsg(null)
            recompute.mutate()
          }}
          title={t('pricing.repriceTitle')}
          type="button"
        >
          {recompute.isPending ? t('pricing.repricing') : t('pricing.reprice')}
        </button>
      </div>
      {recomputeMsg && <div className="mt-2 text-xs text-[color:var(--tx2)]">{recomputeMsg}</div>}
      <div className="mt-2 grid gap-2">
        <QueryState
          emptyLabel={t('pricing.none')}
          errorLabel={t('pricing.loadFailed')}
          isEmpty={profiles.length === 0}
          loadingLabel={t('pricing.loading')}
          query={profilesQuery}
        >
          {() => (
            <>
              {profiles.map((p) => (
                <div key={p.profileId} className="admin-card flex items-center justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <span className="font-semibold text-[var(--tx)]">{p.provider}</span>
                    <span className="ml-2 font-mono text-xs text-[color:var(--tx2)]">{p.modelPattern}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-[color:var(--tx2)]">
                      {t('pricing.rateSummary', {
                        input: rate(p.inputPerMillion, locale),
                        output: rate(p.outputPerMillion, locale),
                        cache: rate(p.cacheReadPerMillion, locale),
                      })}
                    </span>
                    <button
                      className="admin-button admin-button-secondary"
                      disabled={remove.isPending}
                      onClick={() => setPendingDelete(p)}
                      type="button"
                    >
                      {t('delete')}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </QueryState>
      </div>

      <ConfirmDialog
        body={pendingDelete ? t('pricing.deleteBody', {
          provider: pendingDelete.provider, model: pendingDelete.modelPattern,
        }) : undefined}
        confirmLabel={t('pricing.delete')}
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.profileId)
        }}
        open={pendingDelete != null}
        pending={remove.isPending}
        title={t('pricing.deleteTitle')}
      />
    </div>
  )
}
