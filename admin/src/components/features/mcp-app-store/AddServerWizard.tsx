import { useState, type FormEvent } from 'react'
import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
  McpServerAuthConfig,
} from '@nessie/schemas'
import type { CreateCatalogEntryInput } from '../../../facades/mcp-catalog/hooks'

/**
 * "Add MCP server" wizard. Captures the catalog-entry-level metadata an admin
 * needs to publish a new MCP server in the App Store, in three logical steps:
 *
 *   1. transport (stdio | http | sse) and default transport config
 *   2. catalog identity (name, label, vendor, description)
 *   3. auth method (api_key/bearer/basic/oauth2/none) with method-specific config
 *
 * The wizard owns local form state; it calls `onSubmit` with a fully-typed
 * `CreateCatalogEntryInput` once all three steps validate. The page hosting it
 * runs the actual `useCreateCatalogEntry` mutation so error surfacing stays
 * page-level.
 */

type AddServerWizardProps = {
  onCancel: () => void
  onSubmit: (input: CreateCatalogEntryInput) => Promise<void>
  pending?: boolean
}

const PROTOCOLS: McpCatalogProtocol[] = ['stdio', 'http', 'sse', 'ws']
const AUTH_METHODS: McpCatalogAuthMethod[] = [
  'api_key',
  'bearer',
  'basic',
  'oauth2',
  'none',
]

type WizardStep = 'transport' | 'identity' | 'auth'

const labelClass = [
  'text-[11px] font-semibold uppercase tracking-[0.18em]',
  'text-[color:var(--tx3)]',
].join(' ')

const inputClass = [
  'admin-input mt-1 w-full rounded-md border border-[color:var(--sep)]',
  'bg-black/20 px-3 py-2 text-sm text-white',
  'focus:border-[color:var(--accent)] focus:outline-none',
].join(' ')

const buttonPrimary = [
  'admin-button admin-button-primary rounded-md px-4 py-2 text-sm font-semibold',
  'disabled:cursor-not-allowed disabled:opacity-40',
].join(' ')

const buttonGhost = [
  'admin-button rounded-md border border-[color:var(--sep)]',
  'px-4 py-2 text-sm text-[color:var(--tx2)] hover:bg-white/5',
].join(' ')

const buildAuthConfig = (
  method: McpCatalogAuthMethod,
  raw: {
    headerName: string
    valuePrefix: string
    authorizationUrl: string
    tokenUrl: string
    scopes: string
  },
): McpServerAuthConfig => {
  switch (method) {
    case 'api_key':
      return {
        method: 'api_key',
        headerName: raw.headerName.trim() || 'Authorization',
        valuePrefix: raw.valuePrefix,
      }
    case 'oauth2':
      return {
        method: 'oauth2',
        authorizationUrl: raw.authorizationUrl.trim(),
        tokenUrl: raw.tokenUrl.trim(),
        scopes: raw.scopes
          .split(/[\s,]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
      }
    case 'bearer':
      return { method: 'bearer' }
    case 'basic':
      return { method: 'basic' }
    case 'none':
      return { method: 'none' }
  }
}

const buildTransportConfig = (
  protocol: McpCatalogProtocol,
  raw: { url: string; command: string; args: string },
): Record<string, unknown> => {
  switch (protocol) {
    case 'http':
    case 'sse':
      return { transport: protocol, url: raw.url.trim() }
    case 'stdio':
      return {
        transport: 'stdio',
        command: raw.command.trim(),
        args: raw.args
          .split(/\s+/)
          .map((token) => token.trim())
          .filter(Boolean),
      }
    case 'ws':
      return { transport: 'ws', url: raw.url.trim() }
  }
}

type StepErrors = {
  url?: string
  command?: string
  name?: string
  label?: string
  headerName?: string
  authorizationUrl?: string
  tokenUrl?: string
}

const inlineErrorClass = [
  'mt-1 rounded-md border border-rose-400/40 bg-rose-500/10',
  'px-2 py-1 text-xs text-rose-200',
].join(' ')

const parseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw.trim())
  } catch {
    return null
  }
}

const validateTransportStep = (
  protocol: McpCatalogProtocol,
  raw: { url: string; command: string },
): StepErrors => {
  const errors: StepErrors = {}
  if (protocol === 'stdio') {
    if (!raw.command.trim()) {
      errors.command = 'Command is required'
    }
    return errors
  }
  const trimmed = raw.url.trim()
  if (!trimmed) {
    errors.url = 'URL is required'
    return errors
  }
  const parsed = parseUrl(trimmed)
  if (!parsed) {
    errors.url = 'Invalid URL'
    return errors
  }
  if (protocol === 'ws' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    errors.url = 'URL must use ws:// or wss:// scheme'
    return errors
  }
  if (
    (protocol === 'http' || protocol === 'sse')
    && parsed.protocol !== 'http:'
    && parsed.protocol !== 'https:'
  ) {
    errors.url = 'URL must use http:// or https:// scheme'
  }
  return errors
}

const validateIdentityStep = (raw: {
  name: string
  label: string
}): StepErrors => {
  const errors: StepErrors = {}
  if (!raw.name.trim()) errors.name = 'Name is required'
  if (!raw.label.trim()) errors.label = 'Label is required'
  return errors
}

const validateAuthStep = (
  method: McpCatalogAuthMethod,
  raw: { headerName: string; authorizationUrl: string; tokenUrl: string },
): StepErrors => {
  const errors: StepErrors = {}
  if (method === 'api_key') {
    if (!raw.headerName.trim()) errors.headerName = 'Header name is required'
  }
  if (method === 'oauth2') {
    if (!parseUrl(raw.authorizationUrl)) {
      errors.authorizationUrl = 'Authorization URL must be a valid URL'
    }
    if (!parseUrl(raw.tokenUrl)) {
      errors.tokenUrl = 'Token URL must be a valid URL'
    }
  }
  return errors
}

export const AddServerWizard = ({
  onCancel,
  onSubmit,
  pending = false,
}: AddServerWizardProps) => {
  const [step, setStep] = useState<WizardStep>('transport')
  const [protocol, setProtocol] = useState<McpCatalogProtocol>('http')
  const [authMethod, setAuthMethod] = useState<McpCatalogAuthMethod>('api_key')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [vendor, setVendor] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [headerName, setHeaderName] = useState('Authorization')
  const [valuePrefix, setValuePrefix] = useState('Bearer ')
  const [authorizationUrl, setAuthorizationUrl] = useState('')
  const [tokenUrl, setTokenUrl] = useState('')
  const [scopes, setScopes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [stepErrors, setStepErrors] = useState<StepErrors>({})

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    const authErrors = validateAuthStep(authMethod, {
      headerName,
      authorizationUrl,
      tokenUrl,
    })
    if (Object.keys(authErrors).length > 0) {
      setStepErrors(authErrors)
      return
    }
    const identityErrors = validateIdentityStep({ name, label })
    if (Object.keys(identityErrors).length > 0) {
      setStepErrors(identityErrors)
      setStep('identity')
      return
    }
    setStepErrors({})
    try {
      await onSubmit({
        name: name.trim(),
        label: label.trim(),
        description: description.trim() || undefined,
        vendor: vendor.trim() || undefined,
        protocol,
        authMethod,
        authConfig: buildAuthConfig(authMethod, {
          headerName,
          valuePrefix,
          authorizationUrl,
          tokenUrl,
          scopes,
        }),
        defaultTransportConfig: buildTransportConfig(protocol, {
          url,
          command,
          args,
        }),
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to create')
    }
  }

  const advanceFromTransport = () => {
    const errors = validateTransportStep(protocol, { url, command })
    if (Object.keys(errors).length > 0) {
      setStepErrors(errors)
      return
    }
    setStepErrors({})
    setStep('identity')
  }

  const advanceFromIdentity = () => {
    const errors = validateIdentityStep({ name, label })
    if (Object.keys(errors).length > 0) {
      setStepErrors(errors)
      return
    }
    setStepErrors({})
    setStep('auth')
  }

  const goBack = (nextStep: WizardStep) => () => {
    setStepErrors({})
    setStep(nextStep)
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
      <ol className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-[color:var(--tx3)]">
        {(['transport', 'identity', 'auth'] as const).map((value, index) => (
          <li
            className={[
              'rounded-full px-3 py-1',
              step === value
                ? 'bg-[color:var(--accent)] text-white'
                : 'border border-[color:var(--sep)]',
            ].join(' ')}
            key={value}
          >
            {index + 1}. {value}
          </li>
        ))}
      </ol>

      {step === 'transport' && (
        <div className="grid gap-3">
          <label className={labelClass}>
            Transport
            <select
              className={inputClass}
              onChange={(event) =>
                setProtocol(event.target.value as McpCatalogProtocol)
              }
              value={protocol}
            >
              {PROTOCOLS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {(protocol === 'http' || protocol === 'sse' || protocol === 'ws') && (
            <div>
              <label className={labelClass}>
                URL
                <input
                  className={inputClass}
                  data-testid="wizard-url"
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={
                    protocol === 'ws'
                      ? 'wss://example.com/mcp'
                      : 'https://example.com/mcp'
                  }
                  type={protocol === 'ws' ? 'text' : 'url'}
                  value={url}
                />
              </label>
              {stepErrors.url ? (
                <div className={inlineErrorClass} data-testid="wizard-url-error">
                  {stepErrors.url}
                </div>
              ) : null}
            </div>
          )}
          {protocol === 'stdio' && (
            <>
              <div>
                <label className={labelClass}>
                  Command
                  <input
                    className={inputClass}
                    data-testid="wizard-command"
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="/usr/local/bin/my-mcp-server"
                    value={command}
                  />
                </label>
                {stepErrors.command ? (
                  <div className={inlineErrorClass}>{stepErrors.command}</div>
                ) : null}
              </div>
              <label className={labelClass}>
                Args (space separated)
                <input
                  className={inputClass}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="--port 4000"
                  value={args}
                />
              </label>
            </>
          )}
          <div className="flex justify-end gap-2">
            <button className={buttonGhost} onClick={onCancel} type="button">
              Cancel
            </button>
            <button
              className={buttonPrimary}
              data-testid="wizard-transport-continue"
              onClick={advanceFromTransport}
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'identity' && (
        <div className="grid gap-3">
          <div>
            <label className={labelClass}>
              Name (kebab-case, unique per org)
              <input
                className={inputClass}
                data-testid="wizard-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="github-search"
                value={name}
              />
            </label>
            {stepErrors.name ? (
              <div className={inlineErrorClass} data-testid="wizard-name-error">
                {stepErrors.name}
              </div>
            ) : null}
          </div>
          <div>
            <label className={labelClass}>
              Label
              <input
                className={inputClass}
                data-testid="wizard-label"
                onChange={(event) => setLabel(event.target.value)}
                placeholder="GitHub Search"
                value={label}
              />
            </label>
            {stepErrors.label ? (
              <div className={inlineErrorClass}>{stepErrors.label}</div>
            ) : null}
          </div>
          <label className={labelClass}>
            Vendor (optional)
            <input
              className={inputClass}
              onChange={(event) => setVendor(event.target.value)}
              placeholder="GitHub"
              value={vendor}
            />
          </label>
          <label className={labelClass}>
            Description (optional)
            <textarea
              className={inputClass}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              value={description}
            />
          </label>
          <div className="flex justify-between gap-2">
            <button
              className={buttonGhost}
              onClick={goBack('transport')}
              type="button"
            >
              Back
            </button>
            <button
              className={buttonPrimary}
              data-testid="wizard-identity-continue"
              onClick={advanceFromIdentity}
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'auth' && (
        <div className="grid gap-3">
          <label className={labelClass}>
            Auth method
            <select
              className={inputClass}
              onChange={(event) =>
                setAuthMethod(event.target.value as McpCatalogAuthMethod)
              }
              value={authMethod}
            >
              {AUTH_METHODS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {authMethod === 'api_key' && (
            <>
              <div>
                <label className={labelClass}>
                  Header name
                  <input
                    className={inputClass}
                    onChange={(event) => setHeaderName(event.target.value)}
                    placeholder="Authorization"
                    value={headerName}
                  />
                </label>
                {stepErrors.headerName ? (
                  <div className={inlineErrorClass}>{stepErrors.headerName}</div>
                ) : null}
              </div>
              <label className={labelClass}>
                Value prefix (e.g. "Bearer ", "Token ", or empty)
                <input
                  className={inputClass}
                  onChange={(event) => setValuePrefix(event.target.value)}
                  placeholder="Bearer "
                  value={valuePrefix}
                />
              </label>
            </>
          )}
          {authMethod === 'oauth2' && (
            <>
              <div>
                <label className={labelClass}>
                  Authorization URL
                  <input
                    className={inputClass}
                    onChange={(event) => setAuthorizationUrl(event.target.value)}
                    placeholder="https://auth.example.com/authorize"
                    type="url"
                    value={authorizationUrl}
                  />
                </label>
                {stepErrors.authorizationUrl ? (
                  <div className={inlineErrorClass}>
                    {stepErrors.authorizationUrl}
                  </div>
                ) : null}
              </div>
              <div>
                <label className={labelClass}>
                  Token URL
                  <input
                    className={inputClass}
                    onChange={(event) => setTokenUrl(event.target.value)}
                    placeholder="https://auth.example.com/token"
                    type="url"
                    value={tokenUrl}
                  />
                </label>
                {stepErrors.tokenUrl ? (
                  <div className={inlineErrorClass}>{stepErrors.tokenUrl}</div>
                ) : null}
              </div>
              <label className={labelClass}>
                Scopes (space or comma separated)
                <input
                  className={inputClass}
                  onChange={(event) => setScopes(event.target.value)}
                  placeholder="repo read:user"
                  value={scopes}
                />
              </label>
            </>
          )}
          {error ? (
            <div className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              {error}
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <button
              className={buttonGhost}
              onClick={goBack('identity')}
              type="button"
            >
              Back
            </button>
            <button className={buttonPrimary} disabled={pending} type="submit">
              {pending ? 'Creating…' : 'Create catalog entry'}
            </button>
          </div>
        </div>
      )}
    </form>
  )
}
