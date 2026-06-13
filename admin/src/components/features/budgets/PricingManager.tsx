import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../../providers/ApiClientProvider'

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

export const PRICING_PROFILES_KEY = ['pricing-profiles'] as const

const sectionTitle = 'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

const parseRate = (raw: string): number | null | 'invalid' => {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return 'invalid'
  return value
}

const rate = (value: number | null): string => (value == null ? '—' : `$${value}/M`)

export const PricingManager = () => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  const { data: profiles = [] } = useQuery<PricingProfile[]>({
    queryKey: PRICING_PROFILES_KEY,
    queryFn: () => apiClient.get('/api/ledger/tokens/pricing'),
  })

  const [provider, setProvider] = useState('openai')
  const [modelPattern, setModelPattern] = useState('')
  const [input, setInput] = useState('')
  const [output, setOutput] = useState('')
  const [cacheRead, setCacheRead] = useState('')
  const [cacheWrite, setCacheWrite] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: PRICING_PROFILES_KEY })
    // Cost figures everywhere depend on pricing — refresh the summaries too.
    void queryClient.invalidateQueries({ queryKey: ['token-summary'] })
    void queryClient.invalidateQueries({ queryKey: ['token-estimate'] })
    void queryClient.invalidateQueries({ queryKey: ['budgets'] })
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
    onError: (err) => setFormError((err as Error).message),
  })

  const remove = useMutation({
    mutationFn: (profileId: string) =>
      apiClient.delete(`/api/ledger/tokens/pricing/${profileId}`),
    onSuccess: invalidate,
  })

  const handleSave = () => {
    if (provider.trim() === '' || modelPattern.trim() === '') {
      setFormError('Provider and model pattern are required.')
      return
    }
    const rates = {
      inputPerMillion: parseRate(input),
      outputPerMillion: parseRate(output),
      cacheReadPerMillion: parseRate(cacheRead),
      cacheWritePerMillion: parseRate(cacheWrite),
    }
    if (Object.values(rates).some((v) => v === 'invalid')) {
      setFormError('Rates must be non-negative numbers (USD per million tokens) — leave blank to skip.')
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
      <div className={sectionTitle}>Model pricing</div>
      <p className="mt-1 text-xs text-[color:var(--tx2)]">
        Per-million-token rates turn the usage ledger into dollars. Use the exact model name, or
        <code className="mx-1 rounded bg-[var(--overlay-weak)] px-1">*</code> as a provider-wide
        fallback. Saving a model again replaces its current rate.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[color:var(--tx2)]">
          Provider
          <input
            className="admin-input mt-1"
            onChange={(e) => setProvider(e.target.value)}
            placeholder="openai"
            value={provider}
          />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Model pattern
          <input
            className="admin-input mt-1"
            onChange={(e) => setModelPattern(e.target.value)}
            placeholder="gpt-5-mini or *"
            value={modelPattern}
          />
        </label>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="text-xs text-[color:var(--tx2)]">
          Input $/M
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setInput(e.target.value)} placeholder="0.25" value={input} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Output $/M
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setOutput(e.target.value)} placeholder="2.00" value={output} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Cache read $/M
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setCacheRead(e.target.value)} placeholder="0.025" value={cacheRead} />
        </label>
        <label className="text-xs text-[color:var(--tx2)]">
          Cache write $/M
          <input className="admin-input mt-1" inputMode="decimal" onChange={(e) => setCacheWrite(e.target.value)} placeholder="optional" value={cacheWrite} />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button className="admin-button admin-button-secondary" onClick={resetForm} type="button">
          Clear
        </button>
        <button
          className="admin-button admin-button-primary"
          disabled={save.isPending}
          onClick={handleSave}
          type="button"
        >
          Save pricing
        </button>
      </div>
      {formError && <div className="mt-2 text-xs text-[var(--danger-text)]">{formError}</div>}

      <div className={`${sectionTitle} mt-5`}>Configured pricing ({profiles.length})</div>
      <div className="mt-2 grid gap-2">
        {profiles.map((p) => (
          <div key={p.profileId} className="admin-card flex items-center justify-between gap-2 p-3">
            <div className="min-w-0">
              <span className="font-semibold text-[var(--tx)]">{p.provider}</span>
              <span className="ml-2 font-mono text-xs text-[color:var(--tx2)]">{p.modelPattern}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-[color:var(--tx2)]">
                in {rate(p.inputPerMillion)} · out {rate(p.outputPerMillion)} · cache {rate(p.cacheReadPerMillion)}
              </span>
              <button
                className="admin-button admin-button-secondary"
                disabled={remove.isPending}
                onClick={() => remove.mutate(p.profileId)}
                type="button"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="py-6 text-center text-[color:var(--tx3)]">No pricing configured</div>
        )}
      </div>
    </div>
  )
}
