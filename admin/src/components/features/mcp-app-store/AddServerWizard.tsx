import { useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
  McpServerAuthConfig,
} from '@nessie/schemas'
import type { CreateCatalogEntryInput } from '../../../facades/mcp-catalog/hooks'
import {
  clearStepError,
  firstWizardStepError,
  validateIdentityStep,
  validateTransportStep,
  type StepErrors,
  type WizardStep,
} from './add-server-wizard-validation'
import { ariaFor, renderFieldError } from './add-server-wizard-field'

/**
 * "Add MCP server" wizard. Three steps: transport, catalog identity, auth
 * method. Owns local form state and calls `onSubmit` with a typed
 * `CreateCatalogEntryInput`; the hosting page runs the mutation. Validation
 * lives in `./add-server-wizard-validation.ts`.
 */

type AddServerWizardProps = {
  onCancel: () => void
  onSubmit: (input: CreateCatalogEntryInput) => Promise<void>
  pending?: boolean
}

const PROTOCOLS: McpCatalogProtocol[] = ['stdio', 'http', 'sse', 'ws']
const AUTH_METHODS: McpCatalogAuthMethod[] = ['api_key', 'bearer', 'basic', 'oauth2', 'none']

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
  const [stepErrors, setStepErrors] = useState<StepErrors>({})

  const onField = <K extends keyof StepErrors>(
    set: (value: string) => void,
    key: K,
  ) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    set(event.target.value)
    setStepErrors((prev) => clearStepError(prev, key))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    const failure = firstWizardStepError({
      protocol, authMethod, url, command, name, label,
      headerName, authorizationUrl, tokenUrl,
    })
    if (failure) {
      setStepErrors(failure.errors)
      setStep(failure.step)
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
                  onChange={onField(setUrl, 'url')}
                  placeholder={
                    protocol === 'ws'
                      ? 'wss://example.com/mcp'
                      : 'https://example.com/mcp'
                  }
                  type={protocol === 'ws' ? 'text' : 'url'}
                  value={url}
                  {...ariaFor('url', stepErrors)}
                />
              </label>
              {renderFieldError('url', stepErrors.url, 'wizard-url-error')}
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
                    onChange={onField(setCommand, 'command')}
                    placeholder="/usr/local/bin/my-mcp-server"
                    value={command}
                    {...ariaFor('command', stepErrors)}
                  />
                </label>
                {renderFieldError('command', stepErrors.command)}
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
                onChange={onField(setName, 'name')}
                placeholder="github-search"
                value={name}
                {...ariaFor('name', stepErrors)}
              />
            </label>
            {renderFieldError('name', stepErrors.name, 'wizard-name-error')}
          </div>
          <div>
            <label className={labelClass}>
              Label
              <input
                className={inputClass}
                data-testid="wizard-label"
                onChange={onField(setLabel, 'label')}
                placeholder="GitHub Search"
                value={label}
                {...ariaFor('label', stepErrors)}
              />
            </label>
            {renderFieldError('label', stepErrors.label)}
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
                    onChange={onField(setHeaderName, 'headerName')}
                    placeholder="Authorization"
                    value={headerName}
                    {...ariaFor('headerName', stepErrors)}
                  />
                </label>
                {renderFieldError('headerName', stepErrors.headerName)}
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
                    onChange={onField(setAuthorizationUrl, 'authorizationUrl')}
                    placeholder="https://auth.example.com/authorize"
                    type="url"
                    value={authorizationUrl}
                    {...ariaFor('authorizationUrl', stepErrors)}
                  />
                </label>
                {renderFieldError('authorizationUrl', stepErrors.authorizationUrl)}
              </div>
              <div>
                <label className={labelClass}>
                  Token URL
                  <input
                    className={inputClass}
                    onChange={onField(setTokenUrl, 'tokenUrl')}
                    placeholder="https://auth.example.com/token"
                    type="url"
                    value={tokenUrl}
                    {...ariaFor('tokenUrl', stepErrors)}
                  />
                </label>
                {renderFieldError('tokenUrl', stepErrors.tokenUrl)}
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
            <div
              className="rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
              role="alert"
            >{error}</div>
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
