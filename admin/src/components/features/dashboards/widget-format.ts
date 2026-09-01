/**
 * Value formatting for widget renderers.
 *
 * Everything here is driven by the closed `NumberFormat` enum from the widget
 * contract — there is no format string and no formatter callback anywhere in
 * the schema, so an author picks a shape and the renderer decides how to draw
 * it. That is what keeps the boundary closed while still producing currency,
 * percentages and durations that read correctly in the viewer's locale.
 */

import type { DashboardCell, DashboardTone, NumberFormat } from '@nessie/schemas'

/**
 * Semantic tone → the theme custom properties the renderer paints with.
 *
 * Colour never crosses the authoring boundary: an author picks a role, and the
 * mapping to actual colour lives here, so every theme keeps working and no
 * widget can carry a hex value.
 */
export const toneVars: Record<DashboardTone, { line: string; soft: string; text: string }> = {
  neutral: { line: 'var(--tx3)', soft: 'var(--overlay)', text: 'var(--tx2)' },
  accent: { line: 'var(--accent)', soft: 'var(--accent-soft)', text: 'var(--tx)' },
  info: { line: 'var(--info)', soft: 'var(--info-soft)', text: 'var(--info-text)' },
  success: { line: 'var(--executing)', soft: 'var(--success-soft)', text: 'var(--success-text)' },
  warning: { line: 'var(--warning)', soft: 'var(--warning-soft)', text: 'var(--warning-text)' },
  danger: { line: 'var(--danger)', soft: 'var(--danger-soft)', text: 'var(--danger-text)' },
}

/** A fixed rotation for multi-series charts, so series colours are stable. */
export const SERIES_TONES: DashboardTone[] = ['accent', 'info', 'success', 'warning', 'danger']

const durationFrom = (value: number, unit: string | undefined): string => {
  const seconds = unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  if (seconds < 60) return `${Number(seconds.toFixed(1))}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Number((seconds / 3600).toFixed(1))}h`
  return `${Number((seconds / 86400).toFixed(1))}d`
}

const bytesFrom = (value: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${Number(size.toFixed(size < 10 && unit > 0 ? 1 : 0))} ${units[unit]}`
}

export const formatNumber = (value: number, format?: NumberFormat, locale?: string): string => {
  if (!format) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)
  }

  switch (format.kind) {
    case 'currency':
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: format.currency ?? 'USD',
        maximumFractionDigits: format.precision ?? 0,
      }).format(value)
    case 'percent':
      // The contract documents the fractional convention: 0.0123 → 1.23%.
      return new Intl.NumberFormat(locale, {
        style: 'percent',
        maximumFractionDigits: format.precision ?? 1,
      }).format(value)
    case 'compact_number':
      return new Intl.NumberFormat(locale, {
        notation: 'compact',
        maximumFractionDigits: format.precision ?? 1,
      }).format(value)
    case 'duration':
      return durationFrom(value, format.unit)
    case 'bytes':
      return bytesFrom(value)
    case 'number':
    default: {
      const text = new Intl.NumberFormat(locale, {
        maximumFractionDigits: format.precision ?? 2,
      }).format(value)
      return format.unit ? `${text} ${format.unit}` : text
    }
  }
}

/** Null renders as an em dash and is never coerced to zero. */
export const formatCell = (
  value: DashboardCell,
  format?: NumberFormat,
  locale?: string,
): string => {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return formatNumber(value, format, locale)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return value
}

/** A full date+time for a cell, as opposed to the axis's terse form. */
export const formatTemporal = (value: string, locale?: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export const formatAxisDate = (value: string | number, locale?: string): string => {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

/** "2m ago" / "yesterday 17:40" — the freshness footer's own vocabulary. */
export const formatRelative = (iso: string | undefined, locale?: string): string => {
  if (!iso) return 'never'
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return 'unknown'
  const deltaMs = Date.now() - then.getTime()
  const minutes = Math.round(deltaMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) {
    return `yesterday ${new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(then)}`
  }
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(then)
}
