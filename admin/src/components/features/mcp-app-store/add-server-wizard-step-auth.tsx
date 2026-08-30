import type { McpCatalogAuthMethod } from '@nessie/schemas'
import { ariaFor, renderFieldError } from './add-server-wizard-field'
import { Notice } from '../../primitives/Notice'
import { Oauth2Fields } from './add-server-wizard-oauth2-fields'
import { AUTH_METHODS } from './add-server-wizard-config'
import {
  buttonGhost,
  buttonPrimary,
  inputClass,
  labelClass,
} from './add-server-wizard-styles'
import type { AddServerWizardController } from './use-add-server-wizard'

type StepAuthProps = {
  controller: AddServerWizardController
  pending: boolean
}

/** Step 3: auth method configuration, visibility choice, and submit. */
export const StepAuth = ({ controller, pending }: StepAuthProps) => {
  const {
    values,
    stepErrors,
    error,
    setAuthMethod,
    setHeaderName,
    setValuePrefix,
    setAuthorizationUrl,
    setTokenUrl,
    setClientId,
    setClientSecret,
    setScopes,
    setSubmitForReview,
  } = controller
  const { authMethod, submitForReview } = values
  return (
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
                onChange={controller.onField(setHeaderName, 'headerName')}
                placeholder="Authorization"
                value={values.headerName}
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
              value={values.valuePrefix}
            />
          </label>
        </>
      )}
      {authMethod === 'oauth2' && (
        <Oauth2Fields
          classes={{ label: labelClass, input: inputClass }}
          errors={stepErrors}
          onChange={{
            authorizationUrl: controller.onField(
              setAuthorizationUrl,
              'authorizationUrl',
            ),
            tokenUrl: controller.onField(setTokenUrl, 'tokenUrl'),
            clientId: controller.onField(setClientId, 'clientId'),
            clientSecret: controller.onField(setClientSecret, 'clientSecret'),
            scopes: (event) => setScopes(event.target.value),
          }}
          values={{
            authorizationUrl: values.authorizationUrl,
            tokenUrl: values.tokenUrl,
            clientId: values.clientId,
            clientSecret: values.clientSecret,
            scopes: values.scopes,
          }}
        />
      )}
      <fieldset className="grid gap-2 rounded-md border border-[color:var(--sep)] p-3">
        <legend className={labelClass}>Visibility</legend>
        <label className="flex items-start gap-2 text-sm text-[var(--tx)]">
          <input
            checked={!submitForReview}
            data-testid="wizard-visibility-private"
            name="visibility"
            onChange={() => setSubmitForReview(false)}
            type="radio"
          />
          <span>
            Keep private
            <span className="block text-xs text-[color:var(--tx3)]">
              Only you can see and install this connector.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-[var(--tx)]">
          <input
            checked={submitForReview}
            data-testid="wizard-visibility-public"
            name="visibility"
            onChange={() => setSubmitForReview(true)}
            type="radio"
          />
          <span>
            Submit to public store for review
            <span className="block text-xs text-[color:var(--tx3)]">
              A superuser approves it before it appears in the shared store.
            </span>
          </span>
        </label>
      </fieldset>
      {error ? (
        <Notice role="alert" tone="danger">{error}</Notice>
      ) : null}
      <div className="flex justify-between gap-2">
        <button
          className={buttonGhost}
          onClick={controller.goBack('identity')}
          type="button"
        >
          Back
        </button>
        <button className={buttonPrimary} disabled={pending} type="submit">
          {pending
            ? 'Creating…'
            : submitForReview
              ? 'Create & submit for review'
              : 'Create catalog entry'}
        </button>
      </div>
    </div>
  )
}
