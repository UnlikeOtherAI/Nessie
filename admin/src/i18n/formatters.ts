/** Render a short relative time using the active UI locale. */
export const formatRelativeTime = (value: string, locale: string): string => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''

  const deltaMs = timestamp - Date.now()
  const absoluteMinutes = Math.round(Math.abs(deltaMs) / 60_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  if (absoluteMinutes < 1) return formatter.format(0, 'second')
  if (absoluteMinutes < 60) {
    return formatter.format(Math.sign(deltaMs) * absoluteMinutes, 'minute')
  }
  const absoluteHours = Math.round(absoluteMinutes / 60)
  if (absoluteHours < 24) {
    return formatter.format(Math.sign(deltaMs) * absoluteHours, 'hour')
  }
  const absoluteDays = Math.round(absoluteHours / 24)
  if (absoluteDays < 7) {
    return formatter.format(Math.sign(deltaMs) * absoluteDays, 'day')
  }
  return new Date(timestamp).toLocaleDateString(locale)
}
