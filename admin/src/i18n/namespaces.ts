/** Feature-owned catalogs loaded by the shared i18next instance. */
export const translationNamespaces = ['accountMenu'] as const

export type TranslationNamespace = (typeof translationNamespaces)[number]
