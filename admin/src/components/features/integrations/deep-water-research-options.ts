import type {
  DeepWaterResearchLaunchRequest,
  DeepWaterResearchLauncherPreset,
} from '../../../lib/api-client'

export type DeepWaterResearchFormValues = Required<DeepWaterResearchLaunchRequest>

/**
 * A launch is either one of three assumed settings or hand-tuned. The three
 * modes are the whole control surface for most people: they carry a complete
 * set of values, so choosing one answers every question the old fourteen-control
 * form asked. `custom` carries no values of its own — it reveals the full set.
 */
export type DeepWaterResearchMode = 'light' | 'standard' | 'heavy' | 'custom'

/** The settings a mode assumes. Every value is one Ledger/DeepWater accepts. */
export type DeepWaterResearchModeValues = Omit<DeepWaterResearchFormValues, 'query'>

export type DeepWaterResearchModeOption = {
  detail: string
  id: Exclude<DeepWaterResearchMode, 'custom'>
  label: string
  summary: string
  values: DeepWaterResearchModeValues
}

const sharedModeValues = {
  artifactDestination: 'knowledge_draft',
  outputLanguage: 'en',
  recency: 'any',
} as const

const lightMode: DeepWaterResearchModeOption = {
  detail: '3 sections · brief chapters · 2 searches per pillar · standard search',
  id: 'light',
  label: 'Light',
  summary: 'A short orientation, quickly.',
  values: {
    ...sharedModeValues,
    chapterDepth: 'brief',
    depth: 'light',
    outputTier: 'summary',
    searchQuality: 'standard',
    searchesPerPillar: 2,
    sections: 3,
  },
}

const standardMode: DeepWaterResearchModeOption = {
  detail: '8 sections · standard chapters · 4 searches per pillar · standard search',
  id: 'standard',
  label: 'Standard',
  summary: 'A full report for most decisions.',
  values: {
    ...sharedModeValues,
    chapterDepth: 'standard',
    depth: 'standard',
    outputTier: 'full',
    searchQuality: 'standard',
    searchesPerPillar: 4,
    sections: 8,
  },
}

const heavyMode: DeepWaterResearchModeOption = {
  detail: '16 sections · exhaustive chapters · 10 searches per pillar · premium search',
  id: 'heavy',
  label: 'Heavy',
  summary: 'Long-form analysis with broad coverage.',
  values: {
    ...sharedModeValues,
    chapterDepth: 'exhaustive',
    depth: 'heavy',
    outputTier: 'full',
    searchQuality: 'premium',
    searchesPerPillar: 10,
    sections: 16,
  },
}

export const deepWaterResearchModes: DeepWaterResearchModeOption[] = [
  lightMode,
  standardMode,
  heavyMode,
]

export const defaultDeepWaterResearchValues: DeepWaterResearchFormValues = {
  ...standardMode.values,
  query: '',
}

/**
 * Which mode a set of values represents, derived rather than stored — the same
 * rule the Deep Water product uses for its own reach selector. A chat card that
 * prefills exactly one mode's settings opens on that mode; anything else opens
 * on Custom with those settings visible and editable.
 */
export const resolveDeepWaterResearchMode = (
  values: DeepWaterResearchFormValues,
): DeepWaterResearchMode =>
  deepWaterResearchModes.find((mode) => (
    Object.entries(mode.values).every(([key, value]) => (
      values[key as keyof DeepWaterResearchModeValues] === value
    ))
  ))?.id ?? 'custom'

export const deepWaterResearchValuesFromPreset = (
  preset?: DeepWaterResearchLauncherPreset,
): DeepWaterResearchFormValues => ({
  ...defaultDeepWaterResearchValues,
  ...(preset?.artifactDestination ? { artifactDestination: preset.artifactDestination } : {}),
  ...(preset?.chapterDepth ? { chapterDepth: preset.chapterDepth } : {}),
  ...(preset?.depth ? { depth: preset.depth } : {}),
  ...(preset?.outputLanguage ? { outputLanguage: preset.outputLanguage } : {}),
  ...(preset?.outputTier ? { outputTier: preset.outputTier } : {}),
  ...(preset?.recency ? { recency: preset.recency } : {}),
  ...(preset?.searchQuality ? { searchQuality: preset.searchQuality } : {}),
  ...(preset?.searchesPerPillar ? { searchesPerPillar: preset.searchesPerPillar } : {}),
  ...(preset?.sections ? { sections: preset.sections } : {}),
  query: preset?.query ?? '',
})

// ISO 639-1 keeps the request portable: Ledger receives an explicit language
// code while the person launching research sees a readable, complete selector.
export const deepWaterResearchLanguages = [
  { code: 'aa', label: 'Afar' },
  { code: 'ab', label: 'Abkhazian' },
  { code: 'ae', label: 'Avestan' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'ak', label: 'Akan' },
  { code: 'am', label: 'Amharic' },
  { code: 'an', label: 'Aragonese' },
  { code: 'ar', label: 'Arabic' },
  { code: 'as', label: 'Assamese' },
  { code: 'av', label: 'Avaric' },
  { code: 'ay', label: 'Aymara' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'ba', label: 'Bashkir' },
  { code: 'be', label: 'Belarusian' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'bh', label: 'Bihari languages' },
  { code: 'bi', label: 'Bislama' },
  { code: 'bm', label: 'Bambara' },
  { code: 'bn', label: 'Bengali' },
  { code: 'bo', label: 'Tibetan' },
  { code: 'br', label: 'Breton' },
  { code: 'bs', label: 'Bosnian' },
  { code: 'ca', label: 'Catalan' },
  { code: 'ce', label: 'Chechen' },
  { code: 'ch', label: 'Chamorro' },
  { code: 'co', label: 'Corsican' },
  { code: 'cr', label: 'Cree' },
  { code: 'cs', label: 'Czech' },
  { code: 'cu', label: 'Church Slavic' },
  { code: 'cv', label: 'Chuvash' },
  { code: 'cy', label: 'Welsh' },
  { code: 'da', label: 'Danish' },
  { code: 'de', label: 'German' },
  { code: 'dv', label: 'Divehi' },
  { code: 'dz', label: 'Dzongkha' },
  { code: 'ee', label: 'Ewe' },
  { code: 'el', label: 'Greek' },
  { code: 'en', label: 'English' },
  { code: 'eo', label: 'Esperanto' },
  { code: 'es', label: 'Spanish' },
  { code: 'et', label: 'Estonian' },
  { code: 'eu', label: 'Basque' },
  { code: 'fa', label: 'Persian' },
  { code: 'ff', label: 'Fulah' },
  { code: 'fi', label: 'Finnish' },
  { code: 'fj', label: 'Fijian' },
  { code: 'fo', label: 'Faroese' },
  { code: 'fr', label: 'French' },
  { code: 'fy', label: 'Western Frisian' },
  { code: 'ga', label: 'Irish' },
  { code: 'gd', label: 'Scottish Gaelic' },
  { code: 'gl', label: 'Galician' },
  { code: 'gn', label: 'Guarani' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'gv', label: 'Manx' },
  { code: 'ha', label: 'Hausa' },
  { code: 'he', label: 'Hebrew' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ho', label: 'Hiri Motu' },
  { code: 'hr', label: 'Croatian' },
  { code: 'ht', label: 'Haitian' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'hy', label: 'Armenian' },
  { code: 'hz', label: 'Herero' },
  { code: 'ia', label: 'Interlingua' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ie', label: 'Interlingue' },
  { code: 'ig', label: 'Igbo' },
  { code: 'ii', label: 'Sichuan Yi' },
  { code: 'ik', label: 'Inupiaq' },
  { code: 'io', label: 'Ido' },
  { code: 'is', label: 'Icelandic' },
  { code: 'it', label: 'Italian' },
  { code: 'iu', label: 'Inuktitut' },
  { code: 'ja', label: 'Japanese' },
  { code: 'jv', label: 'Javanese' },
  { code: 'ka', label: 'Georgian' },
  { code: 'kg', label: 'Kongo' },
  { code: 'ki', label: 'Kikuyu' },
  { code: 'kj', label: 'Kuanyama' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'kl', label: 'Kalaallisut' },
  { code: 'km', label: 'Khmer' },
  { code: 'kn', label: 'Kannada' },
  { code: 'ko', label: 'Korean' },
  { code: 'kr', label: 'Kanuri' },
  { code: 'ks', label: 'Kashmiri' },
  { code: 'ku', label: 'Kurdish' },
  { code: 'kv', label: 'Komi' },
  { code: 'kw', label: 'Cornish' },
  { code: 'ky', label: 'Kyrgyz' },
  { code: 'la', label: 'Latin' },
  { code: 'lb', label: 'Luxembourgish' },
  { code: 'lg', label: 'Ganda' },
  { code: 'li', label: 'Limburgan' },
  { code: 'ln', label: 'Lingala' },
  { code: 'lo', label: 'Lao' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'lu', label: 'Luba-Katanga' },
  { code: 'lv', label: 'Latvian' },
  { code: 'mg', label: 'Malagasy' },
  { code: 'mh', label: 'Marshallese' },
  { code: 'mi', label: 'Māori' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'ml', label: 'Malayalam' },
  { code: 'mn', label: 'Mongolian' },
  { code: 'mr', label: 'Marathi' },
  { code: 'ms', label: 'Malay' },
  { code: 'mt', label: 'Maltese' },
  { code: 'my', label: 'Burmese' },
  { code: 'na', label: 'Nauru' },
  { code: 'nb', label: 'Norwegian Bokmål' },
  { code: 'nd', label: 'North Ndebele' },
  { code: 'ne', label: 'Nepali' },
  { code: 'ng', label: 'Ndonga' },
  { code: 'nl', label: 'Dutch' },
  { code: 'nn', label: 'Norwegian Nynorsk' },
  { code: 'no', label: 'Norwegian' },
  { code: 'nr', label: 'South Ndebele' },
  { code: 'nv', label: 'Navajo' },
  { code: 'ny', label: 'Chichewa' },
  { code: 'oc', label: 'Occitan' },
  { code: 'oj', label: 'Ojibwa' },
  { code: 'om', label: 'Oromo' },
  { code: 'or', label: 'Odia' },
  { code: 'os', label: 'Ossetian' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'pi', label: 'Pali' },
  { code: 'pl', label: 'Polish' },
  { code: 'ps', label: 'Pashto' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'qu', label: 'Quechua' },
  { code: 'rm', label: 'Romansh' },
  { code: 'rn', label: 'Rundi' },
  { code: 'ro', label: 'Romanian' },
  { code: 'ru', label: 'Russian' },
  { code: 'rw', label: 'Kinyarwanda' },
  { code: 'sa', label: 'Sanskrit' },
  { code: 'sc', label: 'Sardinian' },
  { code: 'sd', label: 'Sindhi' },
  { code: 'se', label: 'Northern Sami' },
  { code: 'sg', label: 'Sango' },
  { code: 'si', label: 'Sinhala' },
  { code: 'sk', label: 'Slovak' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'sm', label: 'Samoan' },
  { code: 'sn', label: 'Shona' },
  { code: 'so', label: 'Somali' },
  { code: 'sq', label: 'Albanian' },
  { code: 'sr', label: 'Serbian' },
  { code: 'ss', label: 'Swati' },
  { code: 'st', label: 'Southern Sotho' },
  { code: 'su', label: 'Sundanese' },
  { code: 'sv', label: 'Swedish' },
  { code: 'sw', label: 'Swahili' },
  { code: 'ta', label: 'Tamil' },
  { code: 'te', label: 'Telugu' },
  { code: 'tg', label: 'Tajik' },
  { code: 'th', label: 'Thai' },
  { code: 'ti', label: 'Tigrinya' },
  { code: 'tk', label: 'Turkmen' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'tn', label: 'Tswana' },
  { code: 'to', label: 'Tonga' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ts', label: 'Tsonga' },
  { code: 'tt', label: 'Tatar' },
  { code: 'tw', label: 'Twi' },
  { code: 'ty', label: 'Tahitian' },
  { code: 'ug', label: 'Uyghur' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ur', label: 'Urdu' },
  { code: 'uz', label: 'Uzbek' },
  { code: 've', label: 'Venda' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'vo', label: 'Volapük' },
  { code: 'wa', label: 'Walloon' },
  { code: 'wo', label: 'Wolof' },
  { code: 'xh', label: 'Xhosa' },
  { code: 'yi', label: 'Yiddish' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'za', label: 'Zhuang' },
  { code: 'zh', label: 'Chinese' },
  { code: 'zu', label: 'Zulu' },
] as const
