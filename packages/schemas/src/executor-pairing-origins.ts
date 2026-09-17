import { z } from 'zod'

/**
 * The Nessie an executor pairs with.
 *
 * Pairing hands a machine key to a server, so this used to be a single pinned
 * origin: an app that accepted any URL was a way to point somebody's machine at
 * a server nobody reviewed. Nessie is open source and people self-host it, so
 * refusing every origin but ours made the product unusable for exactly the
 * people it was written for.
 *
 * The answer is not to drop the check but to make the choice explicit and
 * visible. Two hosted services are named here, so the common cases are one
 * click and cannot be typo-squatted; anything else is `custom`, where the
 * person types the origin themselves and every surface shows them which host
 * they are about to trust — at the choice, in settings, and beside the
 * fingerprint they confirm.
 *
 * One list, three readers. The CLI imports it; the Swift app and the Windows
 * tray restate it in their own language with a test pinning these exact values,
 * the same way `ApprovedAPIOrigin.swift` already restates a rule rather than
 * widening it.
 */
export const EXECUTOR_PAIRING_PRESETS = [
  {
    apiBaseUrl: 'https://api.nessie.works',
    description: 'The hosted Nessie at nessie.works.',
    id: 'nessie',
    label: 'Nessie',
  },
  {
    apiBaseUrl: 'https://api.deeptest.live',
    description: 'The hosted DeepTest at deeptest.live.',
    id: 'deeptest',
    label: 'DeepTest',
  },
] as const

export type ExecutorPairingPreset = (typeof EXECUTOR_PAIRING_PRESETS)[number]
export type ExecutorPairingPresetId = ExecutorPairingPreset['id']

export const ExecutorPairingPresetIdSchema = z.enum(
  EXECUTOR_PAIRING_PRESETS.map((preset) => preset.id) as [ExecutorPairingPresetId, ...ExecutorPairingPresetId[]],
)

/** The local API a development build may pair with, and only a development build. */
export const EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN = 'http://127.0.0.1:5454'

export const executorPairingPreset = (
  id: string,
): ExecutorPairingPreset | undefined =>
  EXECUTOR_PAIRING_PRESETS.find((preset) => preset.id === id)

export type ExecutorPairingOriginVerdict =
  | { ok: true; origin: string; presetId?: ExecutorPairingPresetId }
  | { ok: false; reason: string }

/**
 * The one decision every surface shares: may this executor pair with this
 * origin, and is it one of ours or somebody's own server?
 *
 * A preset id resolves to its pinned origin. Anything else must be an HTTPS
 * origin with no path, query, fragment or credentials — a URL carrying a path
 * is either a mistake or an attempt to make one host look like another in a
 * label, and neither should reach a machine key. `http://` is refused except
 * for the local development origin, and only when a caller says it is a
 * development build.
 */
export const approveExecutorPairingOrigin = (
  value: string,
  options: { allowLocalDevelopment?: boolean } = {},
): ExecutorPairingOriginVerdict => {
  const preset = executorPairingPreset(value.trim())
  if (preset) return { ok: true, origin: preset.apiBaseUrl, presetId: preset.id }

  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return {
      ok: false,
      reason: 'Enter an HTTPS address for the Nessie you are pairing with, such as https://nessie.example.com.',
    }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'A pairing address carries no username or password.' }
  }
  if (parsed.search !== '' || parsed.hash !== '' || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    return {
      ok: false,
      reason: 'A pairing address is an origin only — no path, query or fragment.',
    }
  }
  const origin = parsed.origin
  if (parsed.protocol === 'https:') return { ok: true, origin }
  if (options.allowLocalDevelopment && origin === EXECUTOR_LOCAL_DEVELOPMENT_ORIGIN) {
    return { ok: true, origin }
  }
  return {
    ok: false,
    reason: parsed.protocol === 'http:'
      ? 'A pairing address must be HTTPS. Plain HTTP would expose the pairing challenge on the network.'
      : 'A pairing address must be HTTPS.',
  }
}

/**
 * How a surface names the origin to the person confirming it. A preset is named
 * for the service; anything else is shown as the bare host, because "Custom"
 * alone would hide the one fact that matters.
 */
export const executorPairingOriginLabel = (origin: string): string => {
  const preset = EXECUTOR_PAIRING_PRESETS.find((candidate) => candidate.apiBaseUrl === origin)
  if (preset) return preset.label
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}
