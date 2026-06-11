export type ThemePaletteMode = 'dark' | 'light'

export type SystemColorScheme = ThemePaletteMode | null | undefined

export type ThemePalette = {
  accent: string
  accentHover: string
  accentSoft: string
  accentStrong: string
  borderStrong: string
  colorScheme: ThemePaletteMode
  danger: string
  dangerBorder: string
  dangerSoft: string
  dangerStrong: string
  dangerText: string
  executing: string
  info: string
  infoBorder: string
  infoSoft: string
  infoText: string
  ink: string
  line: string
  link: string
  lnk: string
  main: string
  mainHover: string
  muted: string
  onAccent: string
  overlay: string
  overlayStrong: string
  overlayWeak: string
  panel: string
  panelSoft: string
  rail: string
  sb: string
  sbActive: string
  scrim: string
  scrimStrong: string
  scrimWeak: string
  sep: string
  success: string
  successBorder: string
  successSoft: string
  successText: string
  surfaceInverse: string
  surfaceInverse2: string
  thinking: string
  tx: string
  tx2: string
  tx3: string
  warning: string
  warningBorder: string
  warningSoft: string
  warningText: string
}

export const DARK_PALETTE: ThemePalette = {
  colorScheme: 'dark',
  rail: '#2e1132',
  sb: '#1e1222',
  sbActive: '#6d3579',
  ink: '#2c1832',
  muted: '#7e6e87',
  line: 'rgba(55, 27, 62, 0.18)',
  main: '#1a1d21',
  mainHover: '#222629',
  sep: '#2d2a35',
  borderStrong: '#3d2e50',
  tx: '#d1d2d3',
  tx2: '#c0bfc1',
  tx3: '#949597',
  lnk: '#1d9bd1',
  link: '#1d9bd1',
  accent: '#7c3aed',
  accentSoft: 'rgba(124, 58, 237, 0.16)',
  danger: '#ef4444',
  warning: '#eab308',
  thinking: '#a78bfa',
  executing: '#22c55e',
  panel: '#222629',
  panelSoft: 'rgba(124, 58, 237, 0.08)',
  accentHover: '#6d28d9',
  accentStrong: '#5b21b6',
  onAccent: '#ffffff',
  surfaceInverse: '#faf8fc',
  surfaceInverse2: '#f4eff8',
  success: '#22c55e',
  successSoft: 'rgba(34, 197, 94, 0.15)',
  successBorder: 'rgba(34, 197, 94, 0.45)',
  successText: '#86efac',
  dangerSoft: 'rgba(239, 68, 68, 0.12)',
  dangerBorder: 'rgba(239, 68, 68, 0.35)',
  dangerText: '#fca5a5',
  dangerStrong: '#dc2626',
  warningSoft: 'rgba(234, 179, 8, 0.15)',
  warningBorder: 'rgba(234, 179, 8, 0.35)',
  warningText: '#fde68a',
  info: '#1d9bd1',
  infoSoft: 'rgba(14, 165, 233, 0.15)',
  infoBorder: 'rgba(14, 165, 233, 0.4)',
  infoText: '#7dd3fc',
  overlayWeak: 'rgba(255, 255, 255, 0.06)',
  overlay: 'rgba(255, 255, 255, 0.1)',
  overlayStrong: 'rgba(255, 255, 255, 0.2)',
  scrimWeak: 'rgba(0, 0, 0, 0.1)',
  scrim: 'rgba(0, 0, 0, 0.2)',
  scrimStrong: 'rgba(0, 0, 0, 0.5)',
}

export const LIGHT_PALETTE: ThemePalette = {
  colorScheme: 'light',
  rail: '#eef2f7',
  sb: '#ffffff',
  sbActive: '#2563eb',
  ink: '#111827',
  muted: '#64748b',
  line: 'rgba(15, 23, 42, 0.14)',
  main: '#f8fafc',
  mainHover: '#eef2f7',
  sep: '#d8dee8',
  borderStrong: '#b6c2d2',
  tx: '#111827',
  tx2: '#334155',
  tx3: '#64748b',
  lnk: '#0284c7',
  link: '#0284c7',
  accent: '#2563eb',
  accentSoft: 'rgba(37, 99, 235, 0.12)',
  danger: '#dc2626',
  warning: '#d97706',
  thinking: '#7c3aed',
  executing: '#16a34a',
  panel: '#ffffff',
  panelSoft: 'rgba(37, 99, 235, 0.08)',
  accentHover: '#1d4ed8',
  accentStrong: '#1e40af',
  onAccent: '#ffffff',
  surfaceInverse: '#ffffff',
  surfaceInverse2: '#eef2f7',
  success: '#16a34a',
  successSoft: 'rgba(22, 163, 74, 0.12)',
  successBorder: 'rgba(22, 163, 74, 0.35)',
  successText: '#166534',
  dangerSoft: 'rgba(220, 38, 38, 0.1)',
  dangerBorder: 'rgba(220, 38, 38, 0.32)',
  dangerText: '#b91c1c',
  dangerStrong: '#b91c1c',
  warningSoft: 'rgba(217, 119, 6, 0.14)',
  warningBorder: 'rgba(217, 119, 6, 0.34)',
  warningText: '#92400e',
  info: '#0284c7',
  infoSoft: 'rgba(2, 132, 199, 0.12)',
  infoBorder: 'rgba(2, 132, 199, 0.35)',
  infoText: '#0369a1',
  overlayWeak: 'rgba(15, 23, 42, 0.05)',
  overlay: 'rgba(15, 23, 42, 0.08)',
  overlayStrong: 'rgba(15, 23, 42, 0.14)',
  scrimWeak: 'rgba(15, 23, 42, 0.08)',
  scrim: 'rgba(15, 23, 42, 0.18)',
  scrimStrong: 'rgba(15, 23, 42, 0.45)',
}

export const PALETTES: Record<ThemePaletteMode, ThemePalette> = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
}

const DARK_THEME_PREFERENCES = new Set([
  'nebula',
  'midnight',
  'forest',
  'ocean',
  'sunset',
  'rose',
  'graphite',
  'contrast',
])

const LIGHT_THEME_PREFERENCES = new Set(['daylight', 'sandstone'])

export const resolvePaletteMode = ({
  preference,
  systemScheme,
}: {
  preference: string | null | undefined
  systemScheme: SystemColorScheme
}): ThemePaletteMode => {
  const normalized = preference?.trim().toLowerCase()

  if (normalized && normalized !== 'system') {
    if (DARK_THEME_PREFERENCES.has(normalized)) {
      return 'dark'
    }
    if (LIGHT_THEME_PREFERENCES.has(normalized)) {
      return 'light'
    }
  }

  return systemScheme === 'dark' ? 'dark' : 'light'
}
