import { useState, type ChangeEvent, type FormEvent } from 'react'
import type {
  McpCatalogAuthMethod,
  McpCatalogProtocol,
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
import { buildAuthConfig, buildTransportConfig } from './add-server-wizard-config'

type SubmitFn = (
  input: CreateCatalogEntryInput,
  options: { submitForReview: boolean },
) => Promise<void>

type FieldChange = (
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
) => void

/**
 * State machine for the "Add MCP server" wizard: owns every form field, the
 * current step, validation errors, and the step transitions. Returns the field
 * values, setters/handlers, and navigation callbacks consumed by the step
 * panels and the orchestrating `AddServerWizard` component.
 */
export const useAddServerWizard = (onSubmit: SubmitFn) => {
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
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [scopes, setScopes] = useState('')
  const [submitForReview, setSubmitForReview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stepErrors, setStepErrors] = useState<StepErrors>({})

  const onField = <K extends keyof StepErrors>(
    set: (value: string) => void,
    key: K,
  ): FieldChange => (event) => {
    set(event.target.value)
    setStepErrors((prev) => clearStepError(prev, key))
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    const failure = firstWizardStepError({
      protocol, authMethod, url, command, name, label,
      headerName, authorizationUrl, tokenUrl, clientId, clientSecret,
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
          clientId,
          clientSecret,
          scopes,
        }),
        defaultTransportConfig: buildTransportConfig(protocol, {
          url,
          command,
          args,
        }),
      }, { submitForReview })
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

  return {
    step,
    stepErrors,
    error,
    values: {
      protocol,
      authMethod,
      name,
      label,
      description,
      vendor,
      url,
      command,
      args,
      headerName,
      valuePrefix,
      authorizationUrl,
      tokenUrl,
      clientId,
      clientSecret,
      scopes,
      submitForReview,
    },
    setProtocol,
    setAuthMethod,
    setName,
    setLabel,
    setDescription,
    setVendor,
    setUrl,
    setCommand,
    setArgs,
    setHeaderName,
    setValuePrefix,
    setAuthorizationUrl,
    setTokenUrl,
    setClientId,
    setClientSecret,
    setScopes,
    setSubmitForReview,
    onField,
    submit,
    advanceFromTransport,
    advanceFromIdentity,
    goBack,
  }
}

export type AddServerWizardController = ReturnType<typeof useAddServerWizard>
