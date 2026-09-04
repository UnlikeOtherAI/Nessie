import crypto from 'node:crypto'

import {
  NESSIE_UOA_ORG_CAPABILITIES,
  NESSIE_UOA_ROLE_GRANTS,
} from './uoa-organization-administration.js'

import { loadUoaSettings, type UoaSettings } from '@nessie/team-admin'

import type { SsoTheme } from '../contracts/auth.js'

/**
 * UnlikeOtherAuthenticator (UOA) integration — the config-JWT auto-onboarding
 * flow documented at https://authentication.unlikeotherai.com/llm and `/api`.
 *
 * UOA is not standard OIDC (no `/.well-known/openid-configuration`). A relying
 * party authenticates by:
 *   1. Publishing a JWKS at `https://<domain>/.well-known/jwks.json`.
 *   2. Serving a `config_url` that returns an RS256-signed config JWT describing
 *      the integration (domain, redirect_urls, auth methods, theme).
 *   3. Sending the browser to `GET <base>/auth?config_url=…&redirect_url=…&
 *      code_challenge=…&code_challenge_method=S256`. UOA renders the login UI;
 *      on first contact with a new domain it raises an integration request that
 *      a UOA superuser approves, after which a one-time `client_secret` is
 *      claimed.
 *   4. Exchanging the returned `code` server-to-server at `POST <base>/auth/token`
 *      authenticated with `Bearer <client_hash>` where
 *      `client_hash = SHA256(domain + client_secret)`. The response carries an
 *      HS256 access token whose claims (`sub`, `email`, optional `org`, and
 *      optional `active`) identify the user and selected UOA team; per UOA's
 *      contract the RP does not verify it cryptographically (trust derives from
 *      the authenticated backend channel).
 */

// Settings resolution and the domain-hash bearer moved to
// `@nessie/team-admin` (`uoa-settings.ts`) so the worker's roster reads
// resolve the same environment; everything else about the login flow stays here.
export {
  clientHash,
  isUoaConfigured,
  loadUoaSettings,
  type UoaSettings,
} from '@nessie/team-admin'

export const DESKTOP_REDIRECT_URL = 'nessie://auth/callback'

type UoaSignInThemeColors = {
  bg: string
  border: string
  danger: string
  danger_text: string
  muted: string
  primary: string
  primary_text: string
  surface: string
  text: string
}

const DEFAULT_SSO_THEME = 'space-white' satisfies SsoTheme

// Mirrors the admin theme tokens for the hosted-login surface. UOA cannot read
// Nessie's CSS variables, so the selected palette is passed through the config
// JWT as concrete color values.
export const UOA_SIGN_IN_THEMES = {
  'space-white': {
    colors: {
      primary: '#000000',
      bg: '#f8f8f8',
      surface: '#ffffff',
      text: '#0a0a0a',
      primary_text: '#ffffff',
      muted: '#8a8a8a',
      border: '#e3e6ea',
      danger: '#d63b3b',
      danger_text: '#c23232',
    },
  },
  nebula: {
    colors: {
      primary: '#7c3aed',
      bg: '#1a1d21',
      surface: '#222629',
      text: '#d1d2d3',
      primary_text: '#ffffff',
      muted: '#949597',
      border: '#2d2a35',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  midnight: {
    colors: {
      primary: '#2563eb',
      bg: '#0b1120',
      surface: '#111827',
      text: '#e5e7eb',
      primary_text: '#ffffff',
      muted: '#94a3b8',
      border: '#1f2937',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  daylight: {
    colors: {
      primary: '#2563eb',
      bg: '#f8fafc',
      surface: '#ffffff',
      text: '#111827',
      primary_text: '#ffffff',
      muted: '#64748b',
      border: '#d8dee8',
      danger: '#dc2626',
      danger_text: '#b91c1c',
    },
  },
  forest: {
    colors: {
      primary: '#047857',
      bg: '#0c1a14',
      surface: '#12241c',
      text: '#e5eee8',
      primary_text: '#ffffff',
      muted: '#8aa894',
      border: '#1d3529',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  ocean: {
    colors: {
      primary: '#0e7490',
      bg: '#0b1a22',
      surface: '#102733',
      text: '#e4eef3',
      primary_text: '#ffffff',
      muted: '#8cafbd',
      border: '#1b3644',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  sunset: {
    colors: {
      primary: '#c2410c',
      bg: '#1c130f',
      surface: '#271812',
      text: '#f2e7df',
      primary_text: '#ffffff',
      muted: '#ad8b78',
      border: '#3a2419',
      danger: '#f43f5e',
      danger_text: '#fda4af',
    },
  },
  rose: {
    colors: {
      primary: '#e11d48',
      bg: '#1a1016',
      surface: '#241019',
      text: '#f2e4ea',
      primary_text: '#ffffff',
      muted: '#b08396',
      border: '#341827',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  graphite: {
    colors: {
      primary: '#64748b',
      bg: '#17181a',
      surface: '#1f2123',
      text: '#e5e7eb',
      primary_text: '#ffffff',
      muted: '#9ca3af',
      border: '#2a2c2f',
      danger: '#ef4444',
      danger_text: '#fca5a5',
    },
  },
  sandstone: {
    colors: {
      primary: '#b45309',
      bg: '#faf6ef',
      surface: '#fffdf8',
      text: '#2b2018',
      primary_text: '#ffffff',
      muted: '#806b58',
      border: '#ded0bd',
      danger: '#dc2626',
      danger_text: '#b91c1c',
    },
  },
  contrast: {
    colors: {
      primary: '#4da3ff',
      bg: '#000000',
      surface: '#050505',
      text: '#ffffff',
      primary_text: '#000000',
      muted: '#d0d0d0',
      border: '#f0f0f0',
      danger: '#ff5c7a',
      danger_text: '#ffc4cf',
    },
  },
} satisfies Record<SsoTheme, { colors: UoaSignInThemeColors }>

const resolveUoaSignInTheme = (theme?: SsoTheme): { colors: UoaSignInThemeColors } =>
  UOA_SIGN_IN_THEMES[theme ?? DEFAULT_SSO_THEME]

export const themedConfigUrl = (settings: UoaSettings, theme?: SsoTheme): string => {
  const configUrl = new URL(settings.configUrl)
  if (theme) {
    configUrl.searchParams.set('theme', theme)
  }
  return configUrl.toString()
}

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url')

/**
 * Minimal but schema-complete UI theme. UOA requires the `colors`, `radii`,
 * `density`, `typography`, `button`, `card`, and `logo` sections to be present.
 */
const defaultUiTheme = (settings: UoaSettings, theme?: SsoTheme): Record<string, unknown> => ({
  colors: resolveUoaSignInTheme(theme).colors,
  radii: { card: '16px', button: '10px', input: '8px' },
  density: 'comfortable',
  typography: { font_family: 'Inter, system-ui, sans-serif', base_text_size: 'md' },
  button: { style: 'solid' },
  card: { style: 'shadow' },
  logo: { url: `https://${settings.domain}/icon.png`, alt: 'Nessie' },
})

const allowedRedirectUrls = (settings: UoaSettings): string[] => [
  settings.redirectUrl,
  DESKTOP_REDIRECT_URL,
]

export const ensureAllowedRedirectUrl = (settings: UoaSettings, redirectUri: string): void => {
  if (!new Set(allowedRedirectUrls(settings)).has(redirectUri)) {
    throw new Error(`[uoa] redirect_url is not allowed: ${redirectUri}`)
  }
}

/**
 * Build and sign the config JWT served at the `config_url`. `jwks_url` and
 * `contact_email` are always included so the first call against a new domain
 * triggers UOA auto-discovery / onboarding.
 */
export const buildConfigJwt = (settings: UoaSettings, theme?: SsoTheme): string => {
  const header = base64UrlJson({ alg: 'RS256', kid: settings.kid, typ: 'JWT' })
  const payload = base64UrlJson({
    domain: settings.domain,
    redirect_urls: [settings.redirectUrl, DESKTOP_REDIRECT_URL],
    enabled_auth_methods: ['email_password', 'google'],
    language_config: 'en',
    ui_theme: defaultUiTheme(settings, theme),
    org_features: {
      enabled: true,
      // First organisation for a user with none.
      allow_user_create_org: true,
      // Further teams inside an organisation the user already runs, offered
      // in the SSO team chooser to ACTIVE org owners/admins. Without this,
      // anyone who already belongs to a team sees no create option.
      allow_user_create_team: true,
      // Let the Nessie backend drive the `/org/*` roster and invitation routes
      // with the domain-hash bearer alone (UOA "backend mode" — the
      // `X-UOA-Access-Token` header is omitted entirely; Nessie holds a bound
      // refresh credential, never a spendable user access token). UOA defaults
      // this to false, and while it is false a missing access token stays
      // `401 MISSING_ACCESS_TOKEN`. Backend mode has no acting user, so UOA
      // applies no per-member role check: the owner/admin gate in
      // `routes/team-members.ts` is what authorises every mutation.
      backend_org_management: true,
      // Nessie declares the one product-specific organisation capability in
      // the signed UOA config. UOA keeps role authority; Nessie resolves this
      // capability against its live role response (never a local role mirror).
      capabilities: NESSIE_UOA_ORG_CAPABILITIES,
      role_grants: NESSIE_UOA_ROLE_GRANTS,
    },
    // Slack-style team login: ask UOA to show the team chooser (and to
    // offer email sign-in codes) so a user picks the team they're entering.
    // UOA then issues the `active { orgId, teamId }` claim Nessie routes on
    // (services/team-context.ts). "auto" shows the chooser only when the
    // user has 2+ active teams or a pending invite — single-team users are
    // unaffected. See docs/plans/2026-07-10-slack-workspace-login-nessie.md.
    login_flow: {
      email_code_enabled: true,
      team_selection: 'auto',
    },
    jwks_url: settings.jwksUrl,
    contact_email: settings.contactEmail,
  })
  const signingInput = `${header}.${payload}`
  const signature = crypto
    .sign('RSA-SHA256', Buffer.from(signingInput), settings.privateKeyPem)
    .toString('base64url')
  return `${signingInput}.${signature}`
}

/** Public JWK derived from the configured private key, for the JWKS endpoint. */
export const buildPublicJwks = (settings: UoaSettings): { keys: Record<string, unknown>[] } => {
  const jwk = crypto
    .createPublicKey(settings.privateKeyPem)
    .export({ format: 'jwk' }) as Record<string, unknown>
  return {
    keys: [{ ...jwk, kid: settings.kid, alg: 'RS256', use: 'sig' }],
  }
}

/**
 * Build the UOA authorization URL. The config-JWT flow identifies the client via
 * `config_url` (not a client_id) and carries no `state` — PKCE protects the
 * exchange and the RP keeps its own CSRF token in sessionStorage.
 */
export const buildUoaAuthorizeUrl = (input: {
  codeChallenge: string
  redirectUri: string
  teamHint?: string
  theme?: SsoTheme
}): string => {
  const settings = loadUoaSettings()
  ensureAllowedRedirectUrl(settings, input.redirectUri)

  const url = new URL(`${settings.baseUrl}/auth`)
  url.searchParams.set('config_url', themedConfigUrl(settings, input.theme))
  url.searchParams.set('redirect_url', input.redirectUri)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (input.teamHint) {
    url.searchParams.set('team_hint', input.teamHint)
  }
  return url.toString()
}
