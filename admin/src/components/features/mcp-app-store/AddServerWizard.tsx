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

const PROTOCOLS: McpCatalogProtocol[] = ['stdio', 'http', 'sse']
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

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    if (!name.trim() || !label.trim()) {
      setError('Name and label are required')
      return
    }
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

  const advance = (nextStep: WizardStep) => () => setStep(nextStep)

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
          {(protocol === 'http' || protocol === 'sse') && (
            <label className={labelClass}>
              URL
              <input
                className={inputClass}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/mcp"
                type="url"
                value={url}
              />
            </label>
          )}
          {protocol === 'stdio' && (
            <>
              <label className={labelClass}>
                Command
                <input
                  className={inputClass}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="/usr/local/bin/my-mcp-server"
                  value={command}
                />
              </label>
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
              onClick={advance('identity')}
              type="button"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'identity' && (
        <div className="grid gap-3">
          <label className={labelClass}>
            Name (kebab-case, unique per org)
            <input
              className={inputClass}
              onChange={(event) => setName(event.target.value)}
              placeholder="github-search"
              value={name}
            />
          </label>
          <label className={labelClass}>
            Label
            <input
              className={inputClass}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="GitHub Search"
              value={label}
            />
          </label>
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
              onClick={advance('transport')}
              type="button"
            >
              Back
            </button>
            <button
              className={buttonPrimary}
              onClick={advance('auth')}
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
              <label className={labelClass}>
                Header name
                <input
                  className={inputClass}
                  onChange={(event) => setHeaderName(event.target.value)}
                  placeholder="Authorization"
                  value={headerName}
                />
              </label>
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
              onClick={advance('identity')}
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
