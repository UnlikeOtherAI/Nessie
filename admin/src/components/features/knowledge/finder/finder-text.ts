import i18n from '../../../../i18n/i18n'

/** Translate Finder-owned copy from pure presentation helpers. */
export const finderText = (
  key: string,
  fallback: string,
  values: Record<string, string | number> = {},
): string => {
  if (!i18n.isInitialized) {
    return Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback,
    )
  }
  return i18n.t(key, { ns: 'knowledgeFinder', defaultValue: fallback, ...values })
}
